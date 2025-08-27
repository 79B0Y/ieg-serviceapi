# 多服务管理系统

一个基于 Web 的服务管理平台，专为 Termux 环境设计，支持管理多个服务（Home Assistant、Zigbee2MQTT、Matter Server 等）。提供 REST API 接口、WebSocket 实时通信和完整的 Web 管理界面。

## 功能特性

### 完整的新API端点列表
```bash
# 系统健康检查
curl http://localhost:3008/ieg-serviceapi/health

# 服务管理
curl http://localhost:3008/ieg-serviceapi/services
curl http://localhost:3008/ieg-serviceapi/services/hass
curl http://localhost:3008/ieg-serviceapi/services/hass/status
curl -X POST http://localhost:3008/ieg-serviceapi/services/hass/execute/autocheck

# 批量操作
curl -X POST http://localhost:3008/ieg-serviceapi/services/batch/start \
  -H "Content-Type: application/json" \
  -d '{"services": ["hass", "mosquitto"]}'

# 配置管理
curl -X POST http://localhost:3008/ieg-serviceapi/services/reload

# WebSocket状态
curl http://localhost:3008/ieg-serviceapi/websocket/clients
```

### 核心功能
- **多服务支持**: 自动发现和管理 `serviceupdate.json` 中配置的所有服务
- **实时监控**: WebSocket 实时推送脚本执行状态和输出
- **批量操作**: 支持同时操作多个服务
- **Web 界面**: 现代化响应式界面，支持桌面和移动设备
- **API 调试**: 内置调试界面，便于测试和开发

### 支持的服务
- Home Assistant (`hass`)
- Zigbee2MQTT (`zigbee2mqtt`)
- Matter Server (`matter-server`)
- Node-RED (`node-red`)
- Mosquitto MQTT (`mosquitto`)
- Z-Wave JS UI (`zwave-js-ui`)
- 其他在配置文件中定义的服务

### 支持的操作
每个服务都支持以下脚本操作：
- `autocheck.sh` - 自动状态检查
- `backup.sh` - 创建备份
- `install.sh` - 安装服务
- `restore.sh` - 还原配置
- `start.sh` - 启动服务
- `stop.sh` - 停止服务
- `uninstall.sh` - 卸载服务
- `update.sh` - 更新服务

## 系统要求

### 环境依赖
- **Termux** (Android)
- **Node.js** >= 14.0.0
- **npm** 包管理器

### 必需工具
```bash
pkg install nodejs npm
```

### 服务依赖
- 各服务的管理脚本必须位于 `/data/data/com.termux/files/home/servicemanager/{service_id}/` 目录
- `serviceupdate.json` 配置文件位于 `/data/data/com.termux/files/home/servicemanager/`

## 快速开始

### 1. 创建项目
```bash
mkdir -p /data/data/com.termux/files/home/homeassistant-service-manager
cd /data/data/com.termux/files/home/homeassistant-service-manager
```

### 2. 初始化项目文件
创建 `package.json`:
```json
{
  "name": "homeassistant-service-manager",
  "version": "1.0.0",
  "description": "多服务管理API和Web界面",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "cors": "^2.8.5"
  }
}
```

### 3. 安装依赖
```bash
npm install
```

### 4. 创建项目文件
- 复制服务器代码到 `server.js`
- 创建 `public` 目录并复制前端文件到 `public/index.html`
- 复制调试界面到 `public/debug.html`
- 复制启动脚本并设置执行权限：`chmod +x start.sh`

### 5. 启动服务
```bash
# 使用启动脚本（推荐）
./start.sh --setup  # 初次设置
./start.sh --start  # 启动服务

# 或直接启动
npm start
```

### 6. 访问界面
- **主界面**: http://localhost:3000
- **API调试**: http://localhost:3000/debug.html
- **API文档**: 参见下方API说明

## API 接口

### 基础信息
- **基础URL**: `http://localhost:3000/api`
- **内容类型**: `application/json`
- **WebSocket**: `ws://localhost:3000`

### 主要端点

#### 系统管理
```
GET  /api/health                    # 系统健康状态
GET  /api/services                  # 获取所有服务列表
GET  /api/services/{id}             # 获取特定服务信息
POST /api/services/reload           # 重新加载服务配置
```

#### 服务操作
```
POST /api/services/{id}/execute/{script}     # 执行服务脚本
GET  /api/services/{id}/status              # 获取服务状态
POST /api/services/batch/{script}           # 批量执行脚本
GET  /api/services/status/all               # 获取所有服务状态
```

#### 兼容性接口（默认操作 hass 服务）
```
POST /api/execute/{script}          # 执行脚本
GET  /api/status                    # 获取状态
POST /api/autocheck                 # 状态检查
POST /api/start                     # 启动服务
POST /api/stop                      # 停止服务
POST /api/backup                    # 创建备份
POST /api/install                   # 安装服务
POST /api/update                    # 更新服务
POST /api/restore                   # 还原配置
POST /api/uninstall                 # 卸载服务
```

### 请求示例

#### 执行单个服务脚本
```bash
curl -X POST http://localhost:3000/api/services/hass/execute/autocheck \
  -H "Content-Type: application/json" \
  -d '{}'
```

#### 批量操作多个服务
```bash
curl -X POST http://localhost:3000/api/services/batch/start \
  -H "Content-Type: application/json" \
  -d '{"services": ["hass", "mosquitto", "zigbee2mqtt"]}'
```

#### 获取所有服务状态
```bash
curl http://localhost:3000/api/services/status/all
```

### 响应格式
```json
{
  "service": "hass",
  "script": "autocheck",
  "exitCode": 0,
  "success": true,
  "stdout": "执行输出",
  "stderr": "",
  "output": [
    {
      "type": "stdout",
      "data": "日志内容",
      "timestamp": "2025-01-08T10:30:00.000Z"
    }
  ],
  "timestamp": "2025-01-08T10:30:00.000Z"
}
```

## WebSocket 通信

### 连接
```javascript
const ws = new WebSocket('ws://localhost:3000');

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('消息类型:', data.type);
};
```

### 消息类型
- `connection` - 连接确认
- `script_start` - 脚本开始执行
- `script_output` - 实时输出
- `script_complete` - 执行完成
- `script_error` - 执行错误

## 配置文件

### serviceupdate.json 格式
```json
{
  "generated": "2025-01-08T10:30:00+08:00",
  "services": [
    {
      "id": "hass",
      "display_name": "Home Assistant Core",
      "latest_script_version": "1.0.1",
      "latest_service_version": "2025.1.1",
      "enabled": true,
      "notes": "服务说明",
      "config": {},
      "upgrade_dependencies": ["dependency1"],
      "install_dependencies": ["python3", "python3-pip"]
    }
  ]
}
```

### 环境变量
```bash
export PORT=3000                    # 服务端口
export NODE_ENV=production          # 运行环境
```

## 使用指南

### Web 界面操作

#### 主界面功能
1. **服务状态监控**: 实时显示运行状态、安装状态、版本信息
2. **基础控制**: 状态检查、启动/停止服务、创建备份
3. **高级操作**: 安装、更新、还原配置、卸载服务
4. **实时日志**: WebSocket 实时显示脚本执行输出

#### 调试界面功能
1. **API测试**: 手动构建和发送API请求
2. **服务管理**: 可视化管理所有服务
3. **批量操作**: 一次操作多个服务
4. **响应监控**: 详细的请求/响应日志

### 命令行操作

#### 服务管理
```bash
# 查看所有服务
curl http://localhost:3000/api/services

# 检查特定服务状态
curl http://localhost:3000/api/services/hass/status

# 启动服务
curl -X POST http://localhost:3000/api/services/hass/execute/start

# 批量启动多个服务
curl -X POST http://localhost:3000/api/services/batch/start \
  -H "Content-Type: application/json" \
  -d '{"services": ["hass", "mosquitto"]}'
```

#### 配置管理
```bash
# 重新加载服务配置
curl -X POST http://localhost:3000/api/services/reload

# 安装特定版本
curl -X POST http://localhost:3000/api/services/hass/execute/install \
  -H "Content-Type: application/json" \
  -d '{"params": {"env": {"TARGET_VERSION": "2025.1.1"}}}'
```

## 故障排除

### 常见问题

#### 服务无法启动
```bash
# 检查端口占用
netstat -tulpn | grep :3000

# 查看Node.js进程
ps aux | grep node

# 检查服务目录权限
ls -la /data/data/com.termux/files/home/servicemanager/
```

#### 服务列表为空
1. 检查 `serviceupdate.json` 文件是否存在
2. 验证文件格式是否正确
3. 确认服务 `enabled` 字段不为 `false`

#### WebSocket 连接失败
1. 检查防火墙设置
2. 验证端口可访问性
3. 查看浏览器控制台错误信息

#### 脚本执行失败
```bash
# 检查脚本权限
ls -la /data/data/com.termux/files/home/servicemanager/hass/*.sh

# 手动测试脚本
cd /data/data/com.termux/files/home/servicemanager/hass
bash autocheck.sh
```

### 日志和调试
- 服务器日志: 控制台输出
- 脚本执行日志: WebSocket 实时传输
- 调试界面: http://localhost:3000/debug.html

### 重置和恢复
```bash
# 停止服务
./start.sh --stop

# 清理和重新安装
rm -rf node_modules package-lock.json
npm install

# 完全重置
rm -rf /data/data/com.termux/files/home/homeassistant-service-manager
```

## 开发指南

### 项目结构
```
homeassistant-service-manager/
├── server.js                 # 主服务器
├── package.json              # 项目配置
├── start.sh                  # 启动脚本
├── public/
│   ├── index.html            # 主界面
│   └── debug.html            # 调试界面
├── logs/                     # 日志目录
└── node_modules/             # 依赖包
```

### 本地开发
```bash
# 开发模式
npm run dev
# 或
./start.sh --dev

# 启用调试日志
DEBUG=* npm start
```

### 扩展功能
1. **新增服务**: 在 `serviceupdate.json` 中添加服务配置
2. **自定义脚本**: 在服务目录中添加对应的脚本文件
3. **API扩展**: 在 `server.js` 中添加新的路由
4. **界面定制**: 修改 `public/index.html` 或 `public/debug.html`

## 部署建议

### 生产环境
```bash
# 设置环境变量
export NODE_ENV=production
export PORT=3000

# 使用 PM2 管理进程
npm install -g pm2
pm2 start server.js --name "service-manager"
pm2 startup
pm2 save
```

### 安全考虑
1. 在生产环境中考虑添加身份验证
2. 使用 HTTPS（如果可能）
3. 限制网络访问范围
4. 定期备份配置文件

## 更新日志

### v1.1.0 (当前版本)
- 支持多服务管理
- 新增批量操作功能
- 添加API调试界面
- WebSocket 消息格式扩展
- 向后兼容性保持

### v1.0.0
- 初始版本
- 支持 Home Assistant 管理
- 基础 Web 界面
- REST API 和 WebSocket 支持

## 许可证

MIT License - 详见 LICENSE 文件

## 支持和贡献

- **问题反馈**: GitHub Issues
- **功能请求**: GitHub Discussions  
- **代码贡献**: 欢迎 Pull Request

## 致谢

- Home Assistant 社区
- Node.js 和 Express.js 框架
- WebSocket 技术支持
- 所有贡献者
