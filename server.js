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

// 全局变量存储服务信息
let servicesInfo = {};

// 扫描服务目录作为备用方案
function scanServiceDirectories() {
    console.log('Scanning service directories as fallback...');
    const scannedServices = {};
    
    try {
        if (!fs.existsSync(CONFIG.BASE_SERVICE_DIR)) {
            console.warn('Base service directory does not exist:', CONFIG.BASE_SERVICE_DIR);
            return false;
        }
        
        const dirs = fs.readdirSync(CONFIG.BASE_SERVICE_DIR);
        dirs.forEach(dirName => {
            const servicePath = path.join(CONFIG.BASE_SERVICE_DIR, dirName);
            const autocheckPath = path.join(servicePath, 'autocheck.sh');
            
            if (fs.statSync(servicePath).isDirectory() && fs.existsSync(autocheckPath)) {
                scannedServices[dirName] = {
                    id: dirName,
                    display_name: dirName.charAt(0).toUpperCase() + dirName.slice(1),
                    enabled: true,
                    service_dir: servicePath,
                    scanned: true
                };
                console.log('Discovered service via directory scan:', dirName);
            }
        });
        
        servicesInfo = scannedServices;
        return Object.keys(scannedServices).length > 0;
    } catch (error) {
        console.error('Directory scan failed:', error);
        return false;
    }
}

// 加载服务更新信息 - 修复版本
function loadServicesInfo() {
    servicesInfo = {};
    
    try {
        // 首先验证基础目录存在
        if (!fs.existsSync(CONFIG.BASE_SERVICE_DIR)) {
            console.error('Base service directory does not exist:', CONFIG.BASE_SERVICE_DIR);
            return false;
        }
        
        // 检查serviceupdate.json是否存在
        if (!fs.existsSync(CONFIG.SERVICE_UPDATE_FILE)) {
            console.warn('serviceupdate.json not found, falling back to directory scan');
            return scanServiceDirectories();
        }
        
        const data = fs.readFileSync(CONFIG.SERVICE_UPDATE_FILE, 'utf8');
        const serviceData = JSON.parse(data);
        
        if (!serviceData.services || !Array.isArray(serviceData.services)) {
            console.error('Invalid serviceupdate.json format: missing or invalid services array');
            return scanServiceDirectories();
        }
        
        let loadedCount = 0;
        serviceData.services.forEach(service => {
            // 修复条件判断逻辑
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
                    console.log('Loaded service:', service.id);
                } else {
                    console.warn(`Service ${service.id} configured but directory or autocheck.sh missing`);
                    console.warn(`  Directory exists: ${fs.existsSync(serviceDir)}`);
                    console.warn(`  autocheck.sh exists: ${fs.existsSync(autocheckScript)}`);
                }
            } else if (service.id && service.enabled !== true) {
                console.log(`Service ${service.id} disabled (enabled=${service.enabled})`);
            }
        });
        
        console.log(`Successfully loaded ${loadedCount} services from serviceupdate.json`);
        
        // 如果没有加载到任何服务，尝试目录扫描
        if (loadedCount === 0) {
            console.warn('No services loaded from serviceupdate.json, trying directory scan');
            return scanServiceDirectories();
        }
        
        return true;
    } catch (error) {
        console.error('Failed to load service info:', error);
        console.log('Attempting directory scan as fallback...');
        return scanServiceDirectories();
    }
}

// 定期重新加载服务信息 (每5分钟)
setInterval(loadServicesInfo, 5 * 60 * 1000);

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// WebSocket连接管理
const clients = new Set();

// WebSocket连接处理
wss.on('connection', (ws, request) => {
    console.log('WebSocket client connected');
    clients.add(ws);
    
    ws.on('close', () => {
        console.log('WebSocket client disconnected');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
    });
    
    ws.send(JSON.stringify({
        type: 'connection',
        status: 'connected',
        timestamp: new Date().toISOString()
    }));
});

// 向所有连接的客户端广播消息
function broadcast(data) {
    const message = JSON.stringify(data);
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
            } catch (error) {
                console.error('Broadcast error:', error);
                clients.delete(client);
            }
        }
    });
}

// 扩展的脚本执行函数 - 支持多服务
function executeServiceScript(serviceId, scriptName, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
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
        
        // 构建执行参数
        const args = [];
        if (params.file) args.push(params.file);
        if (params.config) args.push('--config');
        if (params.quiet) args.push('--quiet');
        if (params.json) args.push('--json');
        
        // 设置环境变量
        const env = Object.assign({}, process.env, params.env || {});
        
        console.log(`Executing script: ${serviceId}/${scriptName} - ${scriptPath} ${args.join(' ')}`);
        
        // 广播开始执行
        broadcast({
            type: 'script_start',
            service: serviceId,
            script: scriptName,
            timestamp: new Date().toISOString(),
            params: params
        });
        
        const child = spawn('bash', [scriptPath].concat(args), {
            cwd: serviceDir,
            env: env,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        let output = [];
        
        // 处理标准输出
        child.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            
            // 实时广播输出
            broadcast({
                type: 'script_output',
                service: serviceId,
                script: scriptName,
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
            
            // 实时广播错误
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
            const result = {
                service: serviceId,
                script: scriptName,
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
                exitCode: code,
                success: code === 0,
                stdout: stdout,
                stderr: stderr,
                output: output,
                timestamp: new Date().toISOString()
            });
            
            console.log(`Script ${serviceId}/${scriptName} completed with exit code: ${code}`);
            
            if (code === 0) {
                resolve(result);
            } else {
                reject(result);
            }
        });
        
        // 处理进程错误
        child.on('error', (error) => {
            const errorResult = {
                service: serviceId,
                script: scriptName,
                error: error.message,
                success: false,
                timestamp: new Date().toISOString()
            };
            
            broadcast({
                type: 'script_error',
                service: serviceId,
                script: scriptName,
                error: error.message,
                success: false,
                timestamp: new Date().toISOString()
            });
            
            console.error(`Script ${serviceId}/${scriptName} execution error:`, error);
            reject(errorResult);
        });
        
        // 设置执行超时
        if (options.timeout) {
            setTimeout(() => {
                child.kill('SIGTERM');
                reject({
                    service: serviceId,
                    script: scriptName,
                    error: 'Execution timeout',
                    success: false,
                    timestamp: new Date().toISOString()
                });
            }, options.timeout);
        }
    });
}

// API路由 - 使用统一前缀

// 健康检查 - 增强版本
app.get(CONFIG.API_PREFIX + '/health', (req, res) => {
    const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'IEG Service Manager API',
        version: '1.0.0',
        loaded_services: Object.keys(servicesInfo).length,
        services: Object.keys(servicesInfo),
        config_file_exists: fs.existsSync(CONFIG.SERVICE_UPDATE_FILE),
        base_dir_exists: fs.existsSync(CONFIG.BASE_SERVICE_DIR),
        websocket_clients: clients.size
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
    
    try {
        const result = await executeServiceScript(serviceId, 'autocheck', { json: true });
        if (result.success && result.stdout) {
            try {
                const status = JSON.parse(result.stdout.trim());
                res.json(status);
            } catch (parseError) {
                res.json({ 
                    service: serviceId,
                    status: result.stdout.trim(),
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            res.json({
                service: serviceId,
                status: 'unknown',
                error: 'Failed to get status',
                timestamp: new Date().toISOString()
            });
        }
    } catch (error) {
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
    
    try {
        console.log('执行全局状态检查: ' + statusCheckScript);
        
        // 广播开始执行
        broadcast({
            type: 'script_start',
            service: 'system',
            script: 'statuscheck',
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
            const result = {
                service: 'system',
                script: 'statuscheck',
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
                exitCode: code,
                success: code === 0,
                stdout: stdout,
                stderr: stderr,
                output: output,
                timestamp: new Date().toISOString()
            });
            
            console.log('全局状态检查完成，退出码: ' + code);
            
            if (code === 0) {
                res.json(result);
            } else {
                res.status(500).json(result);
            }
        });
        
        // 处理进程错误
        child.on('error', (error) => {
            console.error('全局状态检查执行错误:', error);
            const errorResult = {
                service: 'system',
                script: 'statuscheck',
                error: error.message,
                success: false,
                timestamp: new Date().toISOString()
            };
            
            broadcast({
                type: 'script_error',
                service: 'system',
                script: 'statuscheck',
                error: error.message,
                timestamp: new Date().toISOString()
            });
            
            res.status(500).json(errorResult);
        });
        
    } catch (error) {
        console.error('启动全局状态检查失败:', error);
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
        res.status(500).json(error);
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
    
    // 并行执行所有服务
    const promises = services.map(async (serviceId) => {
        if (!servicesInfo[serviceId]) {
            errors.push({
                service: serviceId,
                error: '服务不存在'
            });
            return;
        }
        
        try {
            const result = await executeServiceScript(serviceId, scriptName, params, { timeout: timeout });
            results.push(result);
        } catch (error) {
            errors.push(Object.assign({ service: serviceId }, error));
        }
    });
    
    await Promise.allSettled(promises);
    
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
            message: '请使用新的多服务API: ' + CONFIG.API_PREFIX + '/services/{serviceId}/execute/{scriptName}'
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
    console.error('API错误:', error);
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
            'POST ' + CONFIG.API_PREFIX + '/services/{id}/execute/{script}',
            'POST ' + CONFIG.API_PREFIX + '/services/batch/{script}'
        ],
        timestamp: new Date().toISOString()
    });
});

// 启动服务器
server.listen(CONFIG.PORT, () => {
    console.log('IEG服务管理API已启动');
    console.log('HTTP服务器: http://localhost:' + CONFIG.PORT);
    console.log('WebSocket服务器: ws://localhost:' + CONFIG.PORT);
    console.log('API前缀: ' + CONFIG.API_PREFIX);
    console.log('基础服务目录: ' + CONFIG.BASE_SERVICE_DIR);
    
    // 加载服务信息
    const success = loadServicesInfo();
    if (success) {
        console.log('✓ 服务配置加载成功');
        console.log('✓ 可用服务: ' + Object.keys(servicesInfo).join(', '));
    } else {
        console.warn('⚠ 服务配置加载失败，将以兼容模式运行');
    }
});

// 优雅关闭
process.on('SIGTERM', () => {
    console.log('收到SIGTERM信号，正在优雅关闭...');
    server.close(() => {
        console.log('HTTP服务器已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('收到SIGINT信号，正在优雅关闭...');
    server.close(() => {
        console.log('HTTP服务器已关闭');
        process.exit(0);
    });
});
