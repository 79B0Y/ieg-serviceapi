const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 配置
const CONFIG = {
    PORT: process.env.PORT || 3008,
    BASE_SERVICE_DIR: '/data/data/com.termux/files/home/servicemanager',
    SERVICE_UPDATE_FILE: '/data/data/com.termux/files/home/servicemanager/serviceupdate.json',
    API_PREFIX: '/ieg-serviceapi',
    SCRIPTS: {
        autocheck: 'autocheck.sh',
        backup: 'backup.sh',
        install: 'install.sh',
        restore: 'restore.sh',
        start: 'start.sh',
        stop: 'stop.sh',
        uninstall: 'uninstall.sh',
        update: 'update.sh'
    }
};

// 执行锁机制 - 防止无限循环
const executionTracker = new Map();
const lastExecution = new Map();
const broadcastThrottle = new Map();

// 全局变量存储服务信息
let servicesInfo = {};

// 扫描服务目录作为备用方案
function scanServiceDirectories() {
    console.log('[SCAN] Scanning service directories as fallback...');
    const scannedServices = {};
    
    try {
        if (!fs.existsSync(CONFIG.BASE_SERVICE_DIR)) {
            console.warn('[SCAN] Base service directory does not exist:', CONFIG.BASE_SERVICE_DIR);
            return false;
        }
        
        const dirs = fs.readdirSync(CONFIG.BASE_SERVICE_DIR);
        dirs.forEach(dirName => {
            const servicePath = path.join(CONFIG.BASE_SERVICE_DIR, dirName);
            const autocheckPath = path.join(servicePath, 'autocheck.sh');
            
            // 跳过文件和特殊目录
            if (!fs.statSync(servicePath).isDirectory()) return;
            if (dirName.startsWith('.')) return;
            
            if (fs.existsSync(autocheckPath)) {
                scannedServices[dirName] = {
                    id: dirName,
                    display_name: dirName.charAt(0).toUpperCase() + dirName.slice(1),
                    enabled: true,
                    service_dir: servicePath,
                    scanned: true,
                    latest_script_version: 'unknown',
                    latest_service_version: 'unknown'
                };
                console.log('[SCAN] Discovered service:', dirName);
            } else {
                console.log('[SCAN] Skipped directory without autocheck.sh:', dirName);
            }
        });
        
        servicesInfo = scannedServices;
        return Object.keys(scannedServices).length > 0;
    } catch (error) {
        console.error('[SCAN] Directory scan failed:', error);
        return false;
    }
}

// 加载服务更新信息 - 修复版本
function loadServicesInfo() {
    console.log('[LOAD] Loading service information...');
    servicesInfo = {};
    
    try {
        // 首先验证基础目录存在
        if (!fs.existsSync(CONFIG.BASE_SERVICE_DIR)) {
            console.error('[LOAD] Base service directory does not exist:', CONFIG.BASE_SERVICE_DIR);
            return false;
        }
        
        // 检查serviceupdate.json是否存在
        if (!fs.existsSync(CONFIG.SERVICE_UPDATE_FILE)) {
            console.warn('[LOAD] serviceupdate.json not found, falling back to directory scan');
            return scanServiceDirectories();
        }
        
        const data = fs.readFileSync(CONFIG.SERVICE_UPDATE_FILE, 'utf8');
        const serviceData = JSON.parse(data);
        
        if (!serviceData.services || !Array.isArray(serviceData.services)) {
            console.error('[LOAD] Invalid serviceupdate.json format: missing or invalid services array');
            return scanServiceDirectories();
        }
        
        let loadedCount = 0;
        serviceData.services.forEach(service => {
            // 修复条件判断逻辑 - 只加载明确启用的服务
            if (service.id && service.enabled === true) {
                const serviceDir = path.join(CONFIG.BASE_SERVICE_DIR, service.id);
                const autocheckScript = path.join(serviceDir, 'autocheck.sh');
                
                // 验证服务目录和关键脚本存在
                if (fs.existsSync(serviceDir) && fs.existsSync(autocheckScript)) {
                    servicesInfo[service.id] = Object.assign({}, service, {
                        service_dir: serviceDir,
                        display_name: service.display_name || service.id
                    });
                    loadedCount++;
                    console.log('[LOAD] Loaded service:', service.id);
                } else {
                    console.warn(`[LOAD] Service ${service.id} configured but directory or autocheck.sh missing`);
                    console.warn(`[LOAD]   Directory exists: ${fs.existsSync(serviceDir)}`);
                    console.warn(`[LOAD]   autocheck.sh exists: ${fs.existsSync(autocheckScript)}`);
                }
            } else if (service.id && service.enabled !== true) {
                console.log(`[LOAD] Service ${service.id} disabled (enabled=${service.enabled})`);
            }
        });
        
        console.log(`[LOAD] Successfully loaded ${loadedCount} services from serviceupdate.json`);
        
        // 如果没有加载到任何服务，尝试目录扫描
        if (loadedCount === 0) {
            console.warn('[LOAD] No services loaded from serviceupdate.json, trying directory scan');
            return scanServiceDirectories();
        }
        
        return true;
    } catch (error) {
        console.error('[LOAD] Failed to load service info:', error);
        console.log('[LOAD] Attempting directory scan as fallback...');
        return scanServiceDirectories();
    }
}

// 定期重新加载服务信息 (每10分钟，减少频率)
setInterval(() => {
    console.log('[RELOAD] Periodic service info reload...');
    loadServicesInfo();
}, 10 * 60 * 1000);

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// WebSocket连接管理
const clients = new Set();

// WebSocket连接处理
wss.on('connection', (ws, request) => {
    console.log('[WS] WebSocket client connected');
    clients.add(ws);
    
    ws.on('close', () => {
        console.log('[WS] WebSocket client disconnected');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('[WS] WebSocket error:', error);
        clients.delete(ws);
    });
    
    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        timestamp: new Date().toISOString()
    }));
});

// 向所有连接的客户端广播消息 - 添加节流控制
function broadcast(data) {
    const messageKey = `${data.service || 'system'}:${data.script || 'unknown'}:${data.type}`;
    const now = Date.now();
    
    // 对于script_output类型的消息进行节流
    if (data.type === 'script_output') {
        const lastBroadcast = broadcastThrottle.get(messageKey) || 0;
        if (now - lastBroadcast < 1000) { // 1秒内最多广播一次相同的输出
            return;
        }
        broadcastThrottle.set(messageKey, now);
    }
    
    const message = JSON.stringify(data);
    let successCount = 0;
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                successCount++;
            } catch (error) {
                console.error('[WS] Broadcast error:', error);
                clients.delete(client);
            }
        }
    });
    
    // 只对重要消息记录日志
    if (['script_start', 'script_complete', 'script_error'].includes(data.type)) {
        console.log(`[WS] Broadcasted ${data.type} to ${successCount} clients`);
    }
}

// 解析布尔型查询参数，提供默认值
function parseBool(val, defaultValue) {
    if (val === undefined) return defaultValue;
    const s = String(val).toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(s)
        ? true
        : ['0', 'false', 'no', 'n', 'off'].includes(s)
        ? false
        : defaultValue;
}

// 从混合输出中尽力提取JSON对象
function extractJsonFromOutput(text) {
    if (!text) return null;
    const trimmed = text.trim();
    try {
        return JSON.parse(trimmed);
    } catch (_) {
        // 尝试匹配任意大括号包裹的片段
        try {
            const regex = /\{[\s\S]*?\}/g; // 非贪婪匹配多个候选
            const matches = trimmed.match(regex) || [];
            // 从最后一个候选开始尝试
            for (let i = matches.length - 1; i >= 0; i--) {
                const m = matches[i];
                try {
                    return JSON.parse(m);
                } catch (_) { /* 继续尝试 */ }
            }
        } catch (_) { /* 忽略 */ }
    }
    return null;
}

// 扩展的脚本执行函数 - 修复版本，添加执行锁
function executeServiceScript(serviceId, scriptName, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
        const executionKey = `${serviceId}:${scriptName}`;
        const now = Date.now();
        
        // 防止同一脚本在短时间内重复执行
        const lastTime = lastExecution.get(executionKey) || 0;
        if (now - lastTime < 10000) { // 10秒内不允许重复执行
            const elapsed = Math.round((now - lastTime) / 1000);
            console.log(`[EXEC] Skipping ${executionKey} - executed ${elapsed}s ago (too soon)`);
            reject(new Error(`Script executed too recently (${elapsed}s ago)`));
            return;
        }
        
        // 检查是否已在执行中
        if (executionTracker.has(executionKey)) {
            const startTime = executionTracker.get(executionKey);
            const elapsed = now - startTime;
            
            // 如果执行时间超过5分钟，认为是僵尸进程，清除锁
            if (elapsed > 300000) {
                console.warn(`[EXEC] Execution timeout detected for ${executionKey}, clearing lock`);
                executionTracker.delete(executionKey);
            } else {
                const elapsedSeconds = Math.round(elapsed / 1000);
                console.log(`[EXEC] Script ${executionKey} already executing (${elapsedSeconds}s)`);
                reject(new Error(`Script ${executionKey} is already executing (${elapsedSeconds}s)`));
                return;
            }
        }

        // 检查服务是否存在
        if (!servicesInfo[serviceId]) {
            const error = new Error(`Service not found: ${serviceId}`);
            error.available_services = Object.keys(servicesInfo);
            reject(error);
            return;
        }
        
        const serviceDir = servicesInfo[serviceId].service_dir;
        const scriptPath = path.join(serviceDir, CONFIG.SCRIPTS[scriptName]);
        
        // 检查脚本是否存在
        if (!fs.existsSync(scriptPath)) {
            reject(new Error(`Script not found: ${scriptPath}`));
            return;
        }

        // 设置执行锁和记录
        executionTracker.set(executionKey, now);
        lastExecution.set(executionKey, now);
        
        // 构建执行参数
        const args = [];
        if (params.file) args.push(params.file);
        if (params.config) args.push('--config');
        if (params.quiet) args.push('--quiet');
        if (params.json) args.push('--json');
        
        // 设置环境变量并确保Termux路径可用
        const env = Object.assign({}, process.env, params.env || {});
        const termuxPaths = ['/data/data/com.termux/files/usr/bin', '/system/bin', '/system/xbin'];
        const currentPath = env.PATH || process.env.PATH || '';
        const pathParts = currentPath.split(':').filter(Boolean);
        termuxPaths.forEach(p => { if (!pathParts.includes(p)) pathParts.unshift(p); });
        env.PATH = pathParts.join(':');
        
        console.log(`[EXEC] Starting: ${serviceId}/${scriptName} - ${scriptPath} ${args.join(' ')}`);
        
        // 广播开始执行
        broadcast({
            type: 'script_start',
            service: serviceId,
            script: scriptName,
            script_path: scriptPath,
            args: args,
            timestamp: new Date().toISOString(),
            params: params
        });
        // 向日志输出通告所执行的脚本与参数
        broadcast({
            type: 'script_output',
            service: serviceId,
            script: scriptName,
            script_path: scriptPath,
            args: args,
            output_type: 'info',
            data: `执行脚本: ${scriptPath}${args.length ? ' ' + args.join(' ') : ''}`,
            timestamp: new Date().toISOString()
        });
        
        const child = spawn('bash', [scriptPath].concat(args), {
            cwd: serviceDir,
            env: env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        let output = [];
        let outputCount = 0;
        
        // 处理标准输出 - 限制输出频率
        child.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            outputCount++;
            
            // 限制实时广播频率
            if (outputCount % 5 === 0 || text.includes('完成') || text.includes('错误')) {
                broadcast({
                    type: 'script_output',
                    service: serviceId,
                    script: scriptName,
                    output_type: 'stdout',
                    data: text,
                    timestamp: new Date().toISOString()
                });
            }
            
            output.push({ type: 'stdout', data: text, timestamp: new Date().toISOString() });
        });
        
        // 处理标准错误
        child.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            
            // 错误输出总是广播
            broadcast({
                type: 'script_output',
                service: serviceId,
                script: scriptName,
                output_type: 'stderr',
                data: text,
                timestamp: new Date().toISOString()
            });
            
            output.push({ type: 'stderr', data: text, timestamp: new Date().toISOString() });
        });
        
        // 处理进程结束
        child.on('close', (code) => {
            // 清除执行锁
            executionTracker.delete(executionKey);
            
            const result = {
                service: serviceId,
                script: scriptName,
                script_path: scriptPath,
                args: args,
                exitCode: code,
                success: code === 0,
                stdout: stdout,
                stderr: stderr,
                output: output,
                timestamp: new Date().toISOString()
            };
            
            // 广播执行结果
            broadcast({
                type: 'script_complete',
                service: serviceId,
                script: scriptName,
                script_path: scriptPath,
                args: args,
                exitCode: code,
                success: code === 0,
                stdout: stdout,
                stderr: stderr,
                output: output,
                timestamp: new Date().toISOString()
            });
            
            console.log(`[EXEC] Completed: ${serviceId}/${scriptName} (exit code: ${code})`);
            
            if (code === 0) {
                resolve(result);
            } else {
                reject(result);
            }
        });
        
        // 处理进程错误
        child.on('error', (error) => {
            // 清除执行锁
            executionTracker.delete(executionKey);
            
            const errorResult = {
                service: serviceId,
                script: scriptName,
                script_path: scriptPath,
                args: args,
                error: error.message,
                success: false,
                timestamp: new Date().toISOString()
            };
            
            broadcast({
                type: 'script_error',
                service: serviceId,
                script: scriptName,
                script_path: scriptPath,
                args: args,
                error: error.message,
                success: false,
                timestamp: new Date().toISOString()
            });
            
            console.error(`[EXEC] Error: ${serviceId}/${scriptName} - ${error.message}`);
            reject(errorResult);
        });
        
        // 设置执行超时 - 默认2分钟
        const timeout = options.timeout || 120000;
        setTimeout(() => {
            if (executionTracker.has(executionKey)) {
                console.warn(`[EXEC] Timeout: ${executionKey}, killing process`);
                child.kill('SIGTERM');
                setTimeout(() => {
                    if (executionTracker.has(executionKey)) {
                        child.kill('SIGKILL');
                        executionTracker.delete(executionKey);
                    }
                }, 5000);
                
                reject({
                    service: serviceId,
                    script: scriptName,
                    error: 'Execution timeout',
                    success: false,
                    timestamp: new Date().toISOString()
                });
            }
        }, timeout);
    });
}

// API路由 - 使用统一前缀

// 健康检查 - 增强版本
app.get(CONFIG.API_PREFIX + '/health', (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'IEG Service Manager API',
        version: '1.1.0',
        loaded_services: Object.keys(servicesInfo).length,
        services: Object.keys(servicesInfo),
        config_file_exists: fs.existsSync(CONFIG.SERVICE_UPDATE_FILE),
        base_dir_exists: fs.existsSync(CONFIG.BASE_SERVICE_DIR),
        websocket_clients: clients.size,
        active_executions: executionTracker.size
    };
    res.json(health);
});

// 获取所有服务列表
app.get(CONFIG.API_PREFIX + '/services', (req, res) => {
    const services = Object.keys(servicesInfo).map(id => {
        const service = servicesInfo[id];
        return {
            id: id,
            display_name: service.display_name || id,
            latest_script_version: service.latest_script_version || 'unknown',
            latest_service_version: service.latest_service_version || 'unknown',
            enabled: service.enabled !== false,
            notes: service.notes || '',
            service_dir: service.service_dir,
            scanned: service.scanned || false
        };
    });
    
    res.json({
        services: services,
        total: services.length,
        timestamp: new Date().toISOString()
    });
});

// 获取特定服务信息
app.get(CONFIG.API_PREFIX + '/services/:serviceId', (req, res) => {
    const serviceId = req.params.serviceId;
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: '服务不存在',
            service_id: serviceId,
            available_services: Object.keys(servicesInfo)
        });
    }
    
    const service = servicesInfo[serviceId];
    
    res.json(Object.assign({}, service, {
        timestamp: new Date().toISOString()
    }));
});

// 获取特定服务状态
app.get(CONFIG.API_PREFIX + '/services/:serviceId/status', async (req, res) => {
    const serviceId = req.params.serviceId;
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: '服务不存在',
            service_id: serviceId,
            available_services: Object.keys(servicesInfo)
        });
    }
    
    // 支持通过查询参数控制行为：?run=true&json=true&quiet=true&timeout=300000
    const shouldRun = parseBool(req.query.run, false);
    const useJson = parseBool(req.query.json, true);
    const useQuiet = parseBool(req.query.quiet, true);
    const timeout = req.query.timeout ? parseInt(String(req.query.timeout), 10) : undefined;
    
    if (!shouldRun) {
        return res.json({
            service: serviceId,
            executed: false,
            status: 'unknown',
            message: '未执行autocheck。添加 ?run=true 以触发执行',
            timestamp: new Date().toISOString()
        });
    }

    try {
        const result = await executeServiceScript(serviceId, 'autocheck', { json: useJson, quiet: useQuiet }, { timeout });
        if (result.success && typeof result.stdout === 'string') {
            const parsed = extractJsonFromOutput(result.stdout);
            if (parsed) {
                return res.json(parsed);
            }
            return res.json({
                service: serviceId,
                status: result.stdout.trim(),
                note: 'Returned non-JSON stdout; delivering raw text',
                timestamp: new Date().toISOString()
            });
        }
        return res.json({
            service: serviceId,
            status: 'unknown',
            error: 'Failed to get status',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.log(`[STATUS] Failed to get status for ${serviceId}: ${error.message || error.error}`);
        res.json({
            service: serviceId,
            status: 'error',
            error: error.message || error.error || 'Unknown error',
            timestamp: new Date().toISOString()
        });
    }
});

// 全局状态检查接口 - 执行statuscheck.sh
app.post(CONFIG.API_PREFIX + '/statuscheck/all', async (req, res) => {
    const statusCheckScript = '/data/data/com.termux/files/home/servicemanager/statuscheck.sh';
    
    if (!fs.existsSync(statusCheckScript)) {
        return res.status(404).json({
            error: '全局状态检查脚本不存在',
            script_path: statusCheckScript,
            timestamp: new Date().toISOString()
        });
    }
    
    // 防止重复执行
    if (executionTracker.has('system:statuscheck')) {
        return res.status(409).json({
            error: '全局状态检查正在执行中',
            timestamp: new Date().toISOString()
        });
    }
    
    try {
        console.log('[GLOBAL] Starting global status check');
        executionTracker.set('system:statuscheck', Date.now());
        
        // 广播开始执行
        broadcast({
            type: 'script_start',
            service: 'system',
            script: 'statuscheck',
            script_path: statusCheckScript,
            args: [],
            timestamp: new Date().toISOString()
        });
        // 记录执行的脚本路径
        broadcast({
            type: 'script_output',
            service: 'system',
            script: 'statuscheck',
            script_path: statusCheckScript,
            args: [],
            output_type: 'info',
            data: `执行脚本: ${statusCheckScript}`,
            timestamp: new Date().toISOString()
        });
        
        const child = spawn('bash', [statusCheckScript], {
            cwd: '/data/data/com.termux/files/home/servicemanager',
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        let output = [];
        
        // 处理标准输出
        child.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            
            broadcast({
                type: 'script_output',
                service: 'system',
                script: 'statuscheck',
                output_type: 'stdout',
                data: text,
                timestamp: new Date().toISOString()
            });
            
            output.push({ type: 'stdout', data: text, timestamp: new Date().toISOString() });
        });
        
        // 处理标准错误
        child.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            
            broadcast({
                type: 'script_output',
                service: 'system',
                script: 'statuscheck',
                output_type: 'stderr',
                data: text,
                timestamp: new Date().toISOString()
            });
            
            output.push({ type: 'stderr', data: text, timestamp: new Date().toISOString() });
        });
        
        // 处理进程结束
        child.on('close', (code) => {
            executionTracker.delete('system:statuscheck');
            
            const result = {
                service: 'system',
                script: 'statuscheck',
                script_path: statusCheckScript,
                args: [],
                exitCode: code,
                success: code === 0,
                stdout: stdout,
                stderr: stderr,
                output: output,
                timestamp: new Date().toISOString()
            };
            
            broadcast({
                type: 'script_complete',
                service: 'system',
                script: 'statuscheck',
                script_path: statusCheckScript,
                args: [],
                exitCode: code,
                success: code === 0,
                stdout: stdout,
                stderr: stderr,
                output: output,
                timestamp: new Date().toISOString()
            });
            
            console.log(`[GLOBAL] Status check completed (exit code: ${code})`);
            
            if (code === 0) {
                res.json(result);
            } else {
                res.status(500).json(result);
            }
        });
        
        // 处理进程错误
        child.on('error', (error) => {
            executionTracker.delete('system:statuscheck');
            
            const errorResult = {
                service: 'system',
                script: 'statuscheck',
                script_path: statusCheckScript,
                args: [],
                error: error.message,
                success: false,
                timestamp: new Date().toISOString()
            };
            
            broadcast({
                type: 'script_error',
                service: 'system',
                script: 'statuscheck',
                script_path: statusCheckScript,
                args: [],
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            console.error('[GLOBAL] Status check error:', error);
            res.status(500).json(errorResult);
        });
        
        // 设置超时
        setTimeout(() => {
            if (executionTracker.has('system:statuscheck')) {
                child.kill('SIGTERM');
                executionTracker.delete('system:statuscheck');
            }
        }, 300000); // 5分钟超时
        
    } catch (error) {
        executionTracker.delete('system:statuscheck');
        console.error('[GLOBAL] Failed to start status check:', error);
        res.status(500).json({
            error: '启动全局状态检查失败',
            message: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 通用服务脚本执行接口
app.post(CONFIG.API_PREFIX + '/services/:serviceId/execute/:scriptName', async (req, res) => {
    const serviceId = req.params.serviceId;
    const scriptName = req.params.scriptName;
    const params = req.body.params || {};
    const timeout = req.body.timeout;
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: '服务不存在',
            service_id: serviceId,
            available_services: Object.keys(servicesInfo)
        });
    }
    
    if (!CONFIG.SCRIPTS[scriptName]) {
        return res.status(400).json({
            error: '无效的脚本名称',
            script_name: scriptName,
            available_scripts: Object.keys(CONFIG.SCRIPTS)
        });
    }
    
    try {
        const result = await executeServiceScript(serviceId, scriptName, params, { timeout: timeout });
        res.json(result);
    } catch (error) {
        // 如果是执行频率限制，返回429状态码
        if (error.message && error.message.includes('too recently')) {
            res.status(429).json({
                error: '执行过于频繁',
                message: error.message,
                service: serviceId,
                script: scriptName,
                timestamp: new Date().toISOString()
            });
        } else {
            res.status(500).json(error);
        }
    }
});

// 批量服务操作
app.post(CONFIG.API_PREFIX + '/services/batch/:scriptName', async (req, res) => {
    const scriptName = req.params.scriptName;
    const services = req.body.services || [];
    const params = req.body.params || {};
    const timeout = req.body.timeout;
    
    if (!CONFIG.SCRIPTS[scriptName]) {
        return res.status(400).json({
            error: '无效的脚本名称',
            script_name: scriptName,
            available_scripts: Object.keys(CONFIG.SCRIPTS)
        });
    }
    
    if (!Array.isArray(services)) {
        return res.status(400).json({
            error: '请提供服务ID数组',
            example: { services: ['hass', 'zigbee2mqtt'] }
        });
    }
    
    const results = [];
    const errors = [];
    
    // 串行执行避免系统过载
    for (const serviceId of services) {
        if (!servicesInfo[serviceId]) {
            errors.push({
                service: serviceId,
                error: '服务不存在'
            });
            continue;
        }
        
        try {
            const result = await executeServiceScript(serviceId, scriptName, params, { timeout: timeout });
            results.push(result);
        } catch (error) {
            errors.push(Object.assign({ service: serviceId }, error));
        }
        
        // 批量操作间隔，避免系统过载
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    res.json({
        script: scriptName,
        total_services: services.length,
        successful: results.length,
        failed: errors.length,
        results: results,
        errors: errors,
        timestamp: new Date().toISOString()
    });
});

// 重新加载服务配置
app.post(CONFIG.API_PREFIX + '/services/reload', (req, res) => {
    const success = loadServicesInfo();
    
    res.json({
        success: success,
        loaded_services: Object.keys(servicesInfo).length,
        services: Object.keys(servicesInfo),
        timestamp: new Date().toISOString()
    });
});

// WebSocket状态接口
app.get(CONFIG.API_PREFIX + '/websocket/clients', (req, res) => {
    res.json({
        connected_clients: clients.size,
        active_executions: executionTracker.size,
        execution_keys: Array.from(executionTracker.keys()),
        timestamp: new Date().toISOString()
    });
});

// 兼容性接口 - 保持一些基本的向后兼容
app.post(CONFIG.API_PREFIX + '/execute/:scriptName', async (req, res) => {
    const scriptName = req.params.scriptName;
    const params = req.body.params || {};
    const timeout = req.body.timeout;
    
    const serviceId = 'hass';
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: 'Home Assistant服务未配置',
            message: '请使用新的多服务API: ' + CONFIG.API_PREFIX + '/services/{serviceId}/execute/{scriptName}',
            available_services: Object.keys(servicesInfo)
        });
    }
    
    if (!CONFIG.SCRIPTS[scriptName]) {
        return res.status(400).json({
            error: '无效的脚本名称',
            available_scripts: Object.keys(CONFIG.SCRIPTS)
        });
    }
    
    try {
        const result = await executeServiceScript(serviceId, scriptName, params, { timeout: timeout });
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

// 统一错误处理中间件
app.use((error, req, res, next) => {
    console.error('[ERROR] API error:', error);
    res.status(500).json({
        error: '内部服务器错误',
        message: error.message,
        timestamp: new Date().toISOString(),
        path: req.path,
        method: req.method
    });
});

// 404处理
app.use((req, res) => {
    res.status(404).json({
        error: '接口不存在',
        path: req.path,
        method: req.method,
        available_endpoints: [
            'GET ' + CONFIG.API_PREFIX + '/health',
            'GET ' + CONFIG.API_PREFIX + '/services',
            'POST ' + CONFIG.API_PREFIX + '/services/reload',
            'GET ' + CONFIG.API_PREFIX + '/services/{id}/status',
            'POST ' + CONFIG.API_PREFIX + '/services/{id}/execute/{script}',
            'POST ' + CONFIG.API_PREFIX + '/services/batch/{script}',
            'POST ' + CONFIG.API_PREFIX + '/statuscheck/all',
            'GET ' + CONFIG.API_PREFIX + '/websocket/clients'
        ],
        timestamp: new Date().toISOString()
    });
});

// 清理定时器 - 每小时清理过期的执行记录
setInterval(() => {
    const now = Date.now();
    const expireTime = 3600000; // 1小时
    
    // 清理过期的执行记录
    for (const [key, timestamp] of lastExecution.entries()) {
        if (now - timestamp > expireTime) {
            lastExecution.delete(key);
        }
    }
    
    // 清理过期的广播节流记录
    for (const [key, timestamp] of broadcastThrottle.entries()) {
        if (now - timestamp > 60000) { // 1分钟
            broadcastThrottle.delete(key);
        }
    }
    
    console.log(`[CLEANUP] Cleaned execution records, remaining: ${lastExecution.size}`);
}, 3600000);

// 启动服务器
server.listen(CONFIG.PORT, () => {
    console.log('='.repeat(60));
    console.log('IEG服务管理API已启动');
    console.log('HTTP服务器: http://localhost:' + CONFIG.PORT);
    console.log('WebSocket服务器: ws://localhost:' + CONFIG.PORT);
    console.log('API前缀: ' + CONFIG.API_PREFIX);
    console.log('基础服务目录: ' + CONFIG.BASE_SERVICE_DIR);
    console.log('配置文件: ' + CONFIG.SERVICE_UPDATE_FILE);
    console.log('='.repeat(60));
    
    // 加载服务信息
    const success = loadServicesInfo();
    if (success) {
        console.log('✓ 服务配置加载成功');
        console.log('✓ 可用服务: ' + Object.keys(servicesInfo).join(', '));
        console.log('✓ 总计 ' + Object.keys(servicesInfo).length + ' 个服务');
    } else {
        console.warn('⚠ 服务配置加载失败，将以兼容模式运行');
    }
    
    console.log('='.repeat(60));
    console.log('访问地址:');
    console.log('  主界面: http://localhost:' + CONFIG.PORT);
    console.log('  调试界面: http://localhost:' + CONFIG.PORT + '/debug.html');
    console.log('  健康检查: http://localhost:' + CONFIG.PORT + CONFIG.API_PREFIX + '/health');
    console.log('  服务列表: http://localhost:' + CONFIG.PORT + CONFIG.API_PREFIX + '/services');
    console.log('='.repeat(60));
});

// 优雅关闭处理 - 修复版本
function gracefulShutdown(signal) {
    console.log(`\n[SHUTDOWN] 收到${signal}信号，正在关闭...`);
    
    // 立即停止接受新连接
    server.close(() => {
        console.log('[SHUTDOWN] HTTP服务器已关闭');
    });
    
    // 关闭所有WebSocket连接
    clients.forEach(client => {
        try {
            client.close(1000, 'Server shutdown');
        } catch (e) {}
    });
    
    // 清理所有执行锁
    executionTracker.clear();
    lastExecution.clear();
    broadcastThrottle.clear();
    
    console.log('[SHUTDOWN] 清理完成，退出进程');
    
    // 强制退出，不等待
    setTimeout(() => {
        process.exit(0);
    }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 捕获未处理的异常
process.on('uncaughtException', (error) => {
    console.error('[FATAL] Uncaught Exception:', error);
    console.error('[FATAL] Stack trace:', error.stack);
    
    // 给正在执行的操作一点时间完成
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
