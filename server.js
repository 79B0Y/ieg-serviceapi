// 启动服务器
server.listen(CONFIG.PORT, () => {
    console.log(`多服务管理API已启动`);
    console.log(`HTTP服务器: http://localhost:${CONFIG.PORT}`);
    console.log(`WebSocket服务器: ws://localhost:${CONFIG.PORT}`);
    console.log(`基础服务目录: ${CONFIG.BASE_SERVICE_DIR}`);
    
    // 加载服务信息
    constconst express = require('express');
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
    PORT: process.env.PORT || 3000,
    BASE_SERVICE_DIR: '/data/data/com.termux/files/home/servicemanager',
    SERVICE_UPDATE_FILE: '/data/data/com.termux/files/home/servicemanager/serviceupdate.json',
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

// 加载服务更新信息
function loadServicesInfo() {
    try {
        if (fs.existsSync(CONFIG.SERVICE_UPDATE_FILE)) {
            const data = fs.readFileSync(CONFIG.SERVICE_UPDATE_FILE, 'utf8');
            const serviceData = JSON.parse(data);
            
            servicesInfo = {};
            if (serviceData.services && Array.isArray(serviceData.services)) {
                serviceData.services.forEach(service => {
                    if (service.id && service.enabled !== false) {
                        servicesInfo[service.id] = {
                            ...service,
                            service_dir: path.join(CONFIG.BASE_SERVICE_DIR, service.id)
                        };
                    }
                });
            }
            
            console.log(`已加载 ${Object.keys(servicesInfo).length} 个服务:`, Object.keys(servicesInfo).join(', '));
            return true;
        } else {
            console.warn('serviceupdate.json 文件不存在');
            return false;
        }
    } catch (error) {
        console.error('加载服务信息失败:', error);
        return false;
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
    console.log('WebSocket客户端已连接');
    clients.add(ws);
    
    ws.on('close', () => {
        console.log('WebSocket客户端已断开');
        clients.delete(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket错误:', error);
        clients.delete(ws);
    });
    
    // 发送连接确认
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
            client.send(message);
        }
    });
}

// 扩展的脚本执行函数 - 支持多服务
function executeServiceScript(serviceId, scriptName, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
        // 检查服务是否存在
        if (!servicesInfo[serviceId]) {
            reject(new Error(`服务不存在: ${serviceId}`));
            return;
        }
        
        const serviceDir = servicesInfo[serviceId].service_dir;
        const scriptPath = path.join(serviceDir, CONFIG.SCRIPTS[scriptName]);
        
        // 检查脚本是否存在
        if (!fs.existsSync(scriptPath)) {
            reject(new Error(`脚本不存在: ${scriptPath}`));
            return;
        }
        
        // 构建执行参数
        const args = [];
        if (params.file) args.push(params.file);
        if (params.config) args.push('--config');
        if (params.quiet) args.push('--quiet');
        if (params.json) args.push('--json');
        
        // 设置环境变量
        const env = {
            ...process.env,
            ...params.env || {}
        };
        
        console.log(`执行脚本: ${serviceId}/${scriptName} - ${scriptPath} ${args.join(' ')}`);
        
        // 广播开始执行
        broadcast({
            type: 'script_start',
            service: serviceId,
            script: scriptName,
            timestamp: new Date().toISOString(),
            params: params
        });
        
        const child = spawn('bash', [scriptPath, ...args], {
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
                ...result
            });
            
            console.log(`脚本 ${serviceId}/${scriptName} 执行完成，退出码: ${code}`);
            
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
                ...errorResult
            });
            
            console.error(`脚本 ${serviceId}/${scriptName} 执行错误:`, error);
            reject(errorResult);
        });
        
        // 设置执行超时
        if (options.timeout) {
            setTimeout(() => {
                child.kill('SIGTERM');
                reject({
                    service: serviceId,
                    script: scriptName,
                    error: '执行超时',
                    success: false,
                    timestamp: new Date().toISOString()
                });
            }, options.timeout);
        }
    });
}

// API路由
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'Multi-Service Manager API',
        version: '1.0.0',
        loaded_services: Object.keys(servicesInfo).length
    });
});

// 获取所有服务列表
app.get('/api/services', (req, res) => {
    const services = Object.keys(servicesInfo).map(id => {
        const service = servicesInfo[id];
        return {
            id: id,
            display_name: service.display_name || id,
            latest_script_version: service.latest_script_version,
            latest_service_version: service.latest_service_version,
            enabled: service.enabled !== false,
            notes: service.notes || '',
            service_dir: service.service_dir,
            scripts_exist: checkServiceScripts(id)
        };
    });
    
    res.json({
        services: services,
        total: services.length,
        timestamp: new Date().toISOString()
    });
});

// 获取特定服务信息
app.get('/api/services/:serviceId', (req, res) => {
    const { serviceId } = req.params;
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: '服务不存在',
            service_id: serviceId,
            available_services: Object.keys(servicesInfo)
        });
    }
    
    const service = servicesInfo[serviceId];
    const scripts = checkServiceScripts(serviceId);
    
    res.json({
        ...service,
        scripts_available: scripts,
        timestamp: new Date().toISOString()
    });
});

// 检查服务脚本是否存在
function checkServiceScripts(serviceId) {
    if (!servicesInfo[serviceId]) return {};
    
    const serviceDir = servicesInfo[serviceId].service_dir;
    const scripts = {};
    
    Object.keys(CONFIG.SCRIPTS).forEach(scriptName => {
        const scriptPath = path.join(serviceDir, CONFIG.SCRIPTS[scriptName]);
        scripts[scriptName] = {
            filename: CONFIG.SCRIPTS[scriptName],
            path: scriptPath,
            exists: fs.existsSync(scriptPath)
        };
    });
    
    return scripts;
}

// 通用服务脚本执行接口
app.post('/api/services/:serviceId/execute/:scriptName', async (req, res) => {
    const { serviceId, scriptName } = req.params;
    const { params = {}, timeout } = req.body;
    
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
        const result = await executeServiceScript(serviceId, scriptName, params, { timeout });
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

// 批量服务操作
app.post('/api/services/batch/:scriptName', async (req, res) => {
    const { scriptName } = req.params;
    const { services, params = {}, timeout } = req.body;
    
    if (!CONFIG.SCRIPTS[scriptName]) {
        return res.status(400).json({
            error: '无效的脚本名称',
            script_name: scriptName,
            available_scripts: Object.keys(CONFIG.SCRIPTS)
        });
    }
    
    if (!services || !Array.isArray(services)) {
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
            const result = await executeServiceScript(serviceId, scriptName, params, { timeout });
            results.push(result);
        } catch (error) {
            errors.push({
                service: serviceId,
                ...error
            });
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

// 获取服务状态 (支持多服务)
app.get('/api/services/:serviceId/status', async (req, res) => {
    const { serviceId } = req.params;
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: '服务不存在',
            service_id: serviceId
        });
    }
    
    try {
        const result = await executeServiceScript(serviceId, 'status', { json: true });
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
            res.status(500).json(result);
        }
    } catch (error) {
        res.status(500).json(error);
    }
});

// 获取所有服务状态
app.get('/api/services/status/all', async (req, res) => {
    const serviceIds = Object.keys(servicesInfo);
    const statuses = {};
    const errors = {};
    
    // 并行获取所有服务状态
    const promises = serviceIds.map(async (serviceId) => {
        try {
            const result = await executeServiceScript(serviceId, 'status', { json: true, quiet: true });
            if (result.success && result.stdout) {
                try {
                    statuses[serviceId] = JSON.parse(result.stdout.trim());
                } catch (parseError) {
                    statuses[serviceId] = {
                        service: serviceId,
                        status: result.stdout.trim(),
                        parse_error: true
                    };
                }
            } else {
                statuses[serviceId] = {
                    service: serviceId,
                    status: 'unknown',
                    error: 'Failed to get status'
                };
            }
        } catch (error) {
            errors[serviceId] = error.message || 'Unknown error';
            statuses[serviceId] = {
                service: serviceId,
                status: 'error',
                error: error.message
            };
        }
    });
    
    await Promise.allSettled(promises);
    
    res.json({
        services: statuses,
        errors: errors,
        total: serviceIds.length,
        timestamp: new Date().toISOString()
    });
});

// 兼容性接口 - 保持向后兼容
app.post('/api/execute/:scriptName', async (req, res) => {
    const { scriptName } = req.params;
    const { params = {}, timeout } = req.body;
    
    // 默认使用 hass 服务以保持兼容性
    const serviceId = 'hass';
    
    if (!servicesInfo[serviceId]) {
        return res.status(404).json({
            error: 'Home Assistant服务未配置',
            message: '请使用新的多服务API: /api/services/{serviceId}/execute/{scriptName}'
        });
    }
    
    if (!CONFIG.SCRIPTS[scriptName]) {
        return res.status(400).json({
            error: '无效的脚本名称',
            available_scripts: Object.keys(CONFIG.SCRIPTS)
        });
    }
    
    try {
        const result = await executeServiceScript(serviceId, scriptName, params, { timeout });
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

// 兼容性专用脚本接口
app.post('/api/autocheck', async (req, res) => {
    try {
        const result = await executeServiceScript('hass', 'autocheck');
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/backup', async (req, res) => {
    try {
        const result = await executeServiceScript('hass', 'backup');
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/install', async (req, res) => {
    const { version } = req.body;
    const env = version ? { TARGET_VERSION: version } : {};
    
    try {
        const result = await executeServiceScript('hass', 'install', { env }, { timeout: 1800000 });
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/restore', async (req, res) => {
    const { file, config } = req.body;
    const params = {};
    
    if (file) {
        params.env = { RESTORE_FILE: file };
    }
    if (config) {
        params.config = true;
    }
    
    try {
        const result = await executeServiceScript('hass', 'restore', params);
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/start', async (req, res) => {
    try {
        const result = await executeServiceScript('hass', 'start');
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/stop', async (req, res) => {
    try {
        const result = await executeServiceScript('hass', 'stop');
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/uninstall', async (req, res) => {
    try {
        const result = await executeServiceScript('hass', 'uninstall');
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

app.post('/api/update', async (req, res) => {
    const { version } = req.body;
    const env = version ? { TARGET_VERSION: version } : {};
    
    try {
        const result = await executeServiceScript('hass', 'update', { env }, { timeout: 1800000 });
        res.json(result);
    } catch (error) {
        res.status(500).json(error);
    }
});

// 兼容性状态接口
app.get('/api/status', async (req, res) => {
    try {
        const result = await executeServiceScript('hass', 'status', { json: true });
        if (result.success && result.stdout) {
            try {
                const status = JSON.parse(result.stdout.trim());
                res.json(status);
            } catch (parseError) {
                res.json({ 
                    service: 'hass',
                    status: result.stdout.trim(),
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            res.status(500).json(result);
        }
    } catch (error) {
        res.status(500).json(error);
    }
});

// 重新加载服务配置
app.post('/api/services/reload', (req, res) => {
    const success = loadServicesInfo();
    
    res.json({
        success: success,
        loaded_services: Object.keys(servicesInfo).length,
        services: Object.keys(servicesInfo),
        timestamp: new Date().toISOString()
    });
});

// WebSocket状态接口
app.get('/api/websocket/clients', (req, res) => {
    res.json({
        connected_clients: clients.size,
        timestamp: new Date().toISOString()
    });
});

// 错误处理中间件
app.use((error, req, res, next) => {
    console.error('API错误:', error);
    res.status(500).json({
        error: '内部服务器错误',
        message: error.message,
        timestamp: new Date().toISOString()
    });
});

// 404处理
app.use((req, res) => {
    res.status(404).json({
        error: '接口不存在',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

// 启动服务器
server.listen(CONFIG.PORT, () => {
    console.log(`多服务管理API已启动`);
    console.log(`HTTP服务器: http://localhost:${CONFIG.PORT}`);
    console.log(`WebSocket服务器: ws://localhost:${CONFIG.PORT}`);
    console.log(`基础服务目录: ${CONFIG.BASE_SERVICE_DIR}`);
    
    // 加载服务信息
    const success = loadServicesInfo();
    if (success) {
        console.log(`✓ 服务配置加载成功`);
        console.log(`✓ 可用服务: ${Object.keys(servicesInfo).join(', ')}`);
    } else {
        console.warn(`⚠ 服务配置加载失败，将以兼容模式运行`);
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
