#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# Home Assistant 服务管理器启动脚本
# 版本: v1.0.0
# 功能: 初始化和启动服务管理Web界面
# =============================================================================

set -euo pipefail

# 配置变量
PROJECT_NAME="homeassistant-service-manager"
BASE_DIR="/data/data/com.termux/files/home/$PROJECT_NAME"
SERVICE_DIR="/data/data/com.termux/files/home/servicemanager/hass"
PORT="${PORT:-3000}"
NODE_ENV="${NODE_ENV:-production}"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING:${NC} $1"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR:${NC} $1"
}

info() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] INFO:${NC} $1"
}

# 检查依赖
check_dependencies() {
    log "检查系统依赖..."
    
    # 检查Node.js
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js未安装，正在安装..."
        pkg install nodejs
    else
        info "Node.js版本: $(node --version)"
    fi
    
    # 检查npm
    if ! command -v npm >/dev/null 2>&1; then
        error "npm未找到，请确保Node.js正确安装"
        exit 1
    else
        info "npm版本: $(npm --version)"
    fi
    
    # 检查Home Assistant脚本目录
    if [ ! -d "$SERVICE_DIR" ]; then
        error "Home Assistant服务目录不存在: $SERVICE_DIR"
        error "请确保Home Assistant服务管理器已正确安装"
        exit 1
    else
        info "服务目录检查通过: $SERVICE_DIR"
    fi
}

# 创建项目结构
create_project_structure() {
    log "创建项目结构..."
    
    # 创建基础目录
    mkdir -p "$BASE_DIR"
    mkdir -p "$BASE_DIR/public"
    mkdir -p "$BASE_DIR/logs"
    
    cd "$BASE_DIR"
    
    # 创建package.json (如果不存在)
    if [ ! -f "package.json" ]; then
        info "创建package.json..."
        cat > package.json << 'EOF'
{
  "name": "homeassistant-service-manager",
  "version": "1.0.0",
  "description": "Home Assistant服务管理API和Web界面",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "install-deps": "npm install",
    "setup": "npm run install-deps && npm run create-dirs",
    "create-dirs": "mkdir -p public logs",
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [
    "homeassistant",
    "service",
    "management",
    "api",
    "websocket",
    "termux"
  ],
  "author": "Home Assistant Service Manager",
  "license": "MIT",
  "dependencies": {
    "express": "^4.18.2",
    "ws": "^8.14.2",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
EOF
    fi
    
    # 创建前端HTML文件 (如果不存在)
    if [ ! -f "public/index.html" ]; then
        info "创建前端界面..."
        # 这里需要将前端HTML内容写入文件
        # 由于内容较长，建议手动复制前端代码到public/index.html
        warn "请手动将前端HTML代码复制到: $BASE_DIR/public/index.html"
    fi
    
    # 创建服务器文件 (如果不存在)
    if [ ! -f "server.js" ]; then
        info "创建服务器文件..."
        # 这里需要将服务器代码写入文件
        # 由于内容较长，建议手动复制服务器代码到server.js
        warn "请手动将服务器代码复制到: $BASE_DIR/server.js"
    fi
}

# 安装依赖
install_dependencies() {
    log "安装Node.js依赖..."
    cd "$BASE_DIR"
    
    if [ ! -d "node_modules" ]; then
        npm install
    else
        info "依赖已存在，跳过安装"
    fi
}

# 创建systemd服务文件 (如果系统支持)
create_service_file() {
    if [ -d "/data/data/com.termux/files/usr/etc/service" ]; then
        log "创建runit服务配置..."
        
        SERVICE_RUN_DIR="/data/data/com.termux/files/usr/etc/service/ha-web-manager"
        mkdir -p "$SERVICE_RUN_DIR"
        
        cat > "$SERVICE_RUN_DIR/run" << EOF
#!/data/data/com.termux/files/usr/bin/bash
cd $BASE_DIR
export NODE_ENV=$NODE_ENV
export PORT=$PORT
exec node server.js 2>&1
EOF
        chmod +x "$SERVICE_RUN_DIR/run"
        
        info "runit服务文件已创建: $SERVICE_RUN_DIR/run"
    fi
}

# 检查端口占用
check_port() {
    if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
        warn "端口 $PORT 已被占用"
        
        # 尝试找到占用进程
        PID=$(netstat -tulpn 2>/dev/null | grep ":$PORT " | awk '{print $7}' | cut -d/ -f1 | head -1)
        if [ -n "$PID" ]; then
            warn "占用进程PID: $PID"
            
            # 询问是否杀死进程
            read -p "是否杀死占用进程? (y/N): " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                kill "$PID" 2>/dev/null || warn "无法杀死进程 $PID"
                sleep 2
            fi
        fi
    fi
}

# 启动服务
start_service() {
    log "启动Home Assistant服务管理器..."
    cd "$BASE_DIR"
    
    check_port
    
    # 设置环境变量
    export NODE_ENV="$NODE_ENV"
    export PORT="$PORT"
    
    # 启动服务
    if [ "$NODE_ENV" = "development" ]; then
        info "开发模式启动 (使用nodemon)..."
        if command -v nodemon >/dev/null 2>&1; then
            npm run dev
        else
            warn "nodemon未安装，使用普通模式启动..."
            npm start
        fi
    else
        info "生产模式启动..."
        npm start
    fi
}

# 显示使用说明
show_usage() {
    echo "Home Assistant服务管理器启动脚本"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --setup        初始化项目结构和安装依赖"
    echo "  --start        启动服务 (默认)"
    echo "  --dev          开发模式启动"
    echo "  --stop         停止服务"
    echo "  --status       检查服务状态"
    echo "  --port PORT    指定端口 (默认: 3000)"
    echo "  --help         显示此帮助信息"
    echo ""
    echo "环境变量:"
    echo "  PORT          服务端口 (默认: 3000)"
    echo "  NODE_ENV      运行环境 (production/development)"
    echo ""
    echo "示例:"
    echo "  $0 --setup          # 初始化项目"
    echo "  $0 --start          # 启动服务"
    echo "  $0 --dev            # 开发模式启动"
    echo "  $0 --port 8080      # 指定端口启动"
}

# 停止服务
stop_service() {
    log "停止服务..."
    
    # 查找并杀死进程
    PIDS=$(pgrep -f "node.*server.js" || true)
    if [ -n "$PIDS" ]; then
        echo "$PIDS" | while read -r pid; do
            info "停止进程: $pid"
            kill "$pid" 2>/dev/null || true
        done
        sleep 2
        
        # 强制杀死仍在运行的进程
        PIDS=$(pgrep -f "node.*server.js" || true)
        if [ -n "$PIDS" ]; then
            echo "$PIDS" | while read -r pid; do
                warn "强制停止进程: $pid"
                kill -9 "$pid" 2>/dev/null || true
            done
        fi
        
        info "服务已停止"
    else
        info "没有找到运行中的服务"
    fi
}

# 检查服务状态
check_status() {
    info "检查服务状态..."
    
    PIDS=$(pgrep -f "node.*server.js" || true)
    if [ -n "$PIDS" ]; then
        info "服务正在运行，PID: $PIDS"
        
        # 检查端口监听
        if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
            info "服务正在监听端口: $PORT"
            info "访问地址: http://localhost:$PORT"
        else
            warn "服务进程存在但未监听预期端口"
        fi
    else
        info "服务未运行"
    fi
}

# 主函数
main() {
    case "${1:-start}" in
        --setup)
            check_dependencies
            create_project_structure
            install_dependencies
            create_service_file
            info "项目初始化完成!"
            info "请将以下文件内容复制到相应位置:"
            info "1. 服务器代码 -> $BASE_DIR/server.js"
            info "2. 前端页面 -> $BASE_DIR/public/index.html"
            info "然后运行: $0 --start"
            ;;
        --start|start)
            check_dependencies
            start_service
            ;;
        --dev|dev)
            NODE_ENV="development"
            check_dependencies
            start_service
            ;;
        --stop|stop)
            stop_service
            ;;
        --status|status)
            check_status
            ;;
        --port)
            if [ -n "${2:-}" ]; then
                PORT="$2"
                shift 2
                main "${1:-start}"
            else
                error "请指定端口号"
                exit 1
            fi
            ;;
        --help|help|-h)
            show_usage
            ;;
        *)
            error "未知选项: $1"
            show_usage
            exit 1
            ;;
    esac
}

# 确保脚本以正确参数运行
if [ $# -eq 0 ]; then
    main start
else
    main "$@"
fi
