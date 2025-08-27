#!/data/data/com.termux/files/usr/bin/bash
# =============================================================================
# IEG 服务管理器启动脚本 - 增强版本
# 版本: v1.1.0
# 功能: 初始化和启动多服务管理Web界面
# 支持: Home Assistant, Zigbee2MQTT, Matter Server 等多种服务
# =============================================================================

set -euo pipefail

# 配置变量
PROJECT_NAME="ieg-service-manager"
BASE_DIR="/data/data/com.termux/files/home/$PROJECT_NAME"
SERVICE_MANAGER_DIR="/data/data/com.termux/files/home/servicemanager"
PORT="${PORT:-3008}"
NODE_ENV="${NODE_ENV:-production}"
API_PREFIX="/ieg-serviceapi"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
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

success() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS:${NC} $1"
}

# 检查依赖
check_dependencies() {
    log "检查系统依赖..."
    
    # 检查Node.js
    if ! command -v node >/dev/null 2>&1; then
        error "Node.js未安装，正在安装..."
        pkg install nodejs -y
    else
        local node_version=$(node --version)
        info "Node.js版本: $node_version"
        
        # 检查版本是否满足要求
        local major_version=$(echo "$node_version" | sed 's/v\([0-9]*\).*/\1/')
        if [ "$major_version" -lt 14 ]; then
            warn "Node.js版本过低，建议升级到14.0.0以上"
        fi
    fi
    
    # 检查npm
    if ! command -v npm >/dev/null 2>&1; then
        error "npm未找到，请确保Node.js正确安装"
        exit 1
    else
        info "npm版本: $(npm --version)"
    fi
    
    # 检查必要的系统工具
    local missing_tools=()
    for tool in curl jq netstat; do
        if ! command -v "$tool" >/dev/null 2>&1; then
            missing_tools+=("$tool")
        fi
    done
    
    if [ ${#missing_tools[@]} -gt 0 ]; then
        warn "缺少工具: ${missing_tools[*]}"
        info "正在安装缺少的工具..."
        pkg install curl jq net-tools -y
    fi
    
    # 检查服务管理器目录
    if [ ! -d "$SERVICE_MANAGER_DIR" ]; then
        error "服务管理器目录不存在: $SERVICE_MANAGER_DIR"
        error "请确保IEG服务管理器已正确安装"
        exit 1
    else
        info "服务管理器目录检查通过: $SERVICE_MANAGER_DIR"
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
    
    info "项目根目录: $BASE_DIR"
    
    # 验证必要文件是否存在
    local required_files=("server.js" "package.json")
    local missing_files=()
    
    for file in "${required_files[@]}"; do
        if [ ! -f "$file" ]; then
            missing_files+=("$file")
        fi
    done
    
    if [ ${#missing_files[@]} -gt 0 ]; then
        error "缺少必要文件: ${missing_files[*]}"
        error "请确保以下文件存在于 $BASE_DIR 目录中:"
        for file in "${missing_files[@]}"; do
            error "  - $file"
        done
        exit 1
    fi
    
    # 验证前端文件
    if [ ! -f "public/index.html" ]; then
        warn "前端界面文件不存在: public/index.html"
        warn "Web界面将无法正常访问"
    fi
    
    if [ ! -f "public/debug.html" ]; then
        warn "调试界面文件不存在: public/debug.html"
        warn "API调试功能将无法使用"
    fi
}

# 安装依赖
install_dependencies() {
    log "检查并安装Node.js依赖..."
    cd "$BASE_DIR"
    
    if [ ! -f "package.json" ]; then
        error "package.json不存在"
        exit 1
    fi
    
    # 检查是否需要安装依赖
    if [ ! -d "node_modules" ] || [ ! -f "package-lock.json" ]; then
        info "安装Node.js依赖包..."
        npm install
    else
        info "检查依赖包更新..."
        npm audit fix --silent 2>/dev/null || true
        info "依赖包检查完成"
    fi
    
    # 验证关键依赖
    local critical_deps=("express" "ws" "cors")
    for dep in "${critical_deps[@]}"; do
        if ! npm list "$dep" >/dev/null 2>&1; then
            warn "关键依赖 $dep 可能未正确安装"
        fi
    done
}

# 验证服务配置
validate_service_config() {
    log "验证服务配置..."
    
    local config_file="$SERVICE_MANAGER_DIR/serviceupdate.json"
    if [ -f "$config_file" ]; then
        info "找到服务配置文件: $config_file"
        
        # 验证JSON格式
        if jq . "$config_file" >/dev/null 2>&1; then
            local service_count=$(jq '.services | length' "$config_file" 2>/dev/null || echo 0)
            info "配置文件格式正确，包含 $service_count 个服务定义"
            
            # 列出启用的服务
            local enabled_services=$(jq -r '.services[] | select(.enabled == true) | .id' "$config_file" 2>/dev/null)
            if [ -n "$enabled_services" ]; then
                info "启用的服务:"
                echo "$enabled_services" | while read -r service; do
                    info "  - $service"
                    # 检查服务目录是否存在
                    local service_dir="$SERVICE_MANAGER_DIR/$service"
                    if [ -d "$service_dir" ]; then
                        if [ -f "$service_dir/autocheck.sh" ]; then
                            info "    ✓ 服务目录和脚本完整"
                        else
                            warn "    ✗ 缺少 autocheck.sh"
                        fi
                    else
                        warn "    ✗ 服务目录不存在: $service_dir"
                    fi
                done
            else
                warn "没有找到启用的服务"
            fi
        else
            error "服务配置文件格式错误"
            error "请检查 $config_file 的JSON语法"
        fi
    else
        warn "服务配置文件不存在: $config_file"
        warn "将使用目录扫描模式发现服务"
        
        # 扫描可用服务目录
        info "扫描可用服务:"
        for service_dir in "$SERVICE_MANAGER_DIR"/*; do
            if [ -d "$service_dir" ] && [ -f "$service_dir/autocheck.sh" ]; then
                local service_name=$(basename "$service_dir")
                info "  - $service_name (通过目录扫描发现)"
            fi
        done
    fi
}

# 检查端口占用
check_port() {
    log "检查端口占用情况..."
    
    if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
        warn "端口 $PORT 已被占用"
        
        # 尝试找到占用进程
        local pid=$(netstat -tulpn 2>/dev/null | grep ":$PORT " | awk '{print $7}' | cut -d/ -f1 | head -1)
        if [ -n "$pid" ] && [ "$pid" != "-" ]; then
            local process_info=$(ps -p "$pid" -o pid,ppid,cmd --no-headers 2>/dev/null || echo "")
            if [ -n "$process_info" ]; then
                warn "占用进程信息: $process_info"
                
                # 检查是否是自己的进程
                if echo "$process_info" | grep -q "node.*server.js"; then
                    info "发现已有的服务管理器实例正在运行"
                    read -p "是否停止现有实例并重新启动? (y/N): " -n 1 -r
                    echo
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        info "停止现有实例..."
                        kill "$pid" 2>/dev/null || warn "无法停止进程 $pid"
                        sleep 3
                    else
                        info "保持现有实例运行"
                        return 0
                    fi
                else
                    read -p "是否强制停止占用进程? (y/N): " -n 1 -r
                    echo
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        kill "$pid" 2>/dev/null || warn "无法停止进程 $pid"
                        sleep 2
                    fi
                fi
            fi
        fi
    else
        info "端口 $PORT 可用"
    fi
}

# 创建系统服务配置
create_service_config() {
    if [ -d "/data/data/com.termux/files/usr/etc/service" ]; then
        log "创建runit服务配置..."
        
        local service_run_dir="/data/data/com.termux/files/usr/etc/service/ieg-service-manager"
        mkdir -p "$service_run_dir"
        
        cat > "$service_run_dir/run" << EOF
#!/data/data/com.termux/files/usr/bin/bash
cd $BASE_DIR
export NODE_ENV=$NODE_ENV
export PORT=$PORT
exec node server.js 2>&1
EOF
        chmod +x "$service_run_dir/run"
        
        info "runit服务配置已创建: $service_run_dir/run"
    fi
}

# 启动服务
start_service() {
    log "启动IEG服务管理器..."
    cd "$BASE_DIR"
    
    check_port
    
    # 设置环境变量
    export NODE_ENV="$NODE_ENV"
    export PORT="$PORT"
    
    info "服务配置:"
    info "  - 端口: $PORT"
    info "  - 环境: $NODE_ENV"
    info "  - API前缀: $API_PREFIX"
    info "  - 项目目录: $BASE_DIR"
    info "  - 服务目录: $SERVICE_MANAGER_DIR"
    
    # 创建启动日志
    local log_file="$BASE_DIR/logs/startup.log"
    mkdir -p "$(dirname "$log_file")"
    
    # 启动服务
    if [ "$NODE_ENV" = "development" ]; then
        info "开发模式启动 (使用nodemon)..."
        if command -v nodemon >/dev/null 2>&1; then
            npm run dev 2>&1 | tee "$log_file"
        else
            warn "nodemon未安装，使用普通模式启动..."
            npm start 2>&1 | tee "$log_file"
        fi
    else
        info "生产模式启动..."
        info "访问地址:"
        info "  - 主界面: http://localhost:$PORT"
        info "  - API调试: http://localhost:$PORT/debug.html"
        info "  - 健康检查: http://localhost:$PORT$API_PREFIX/health"
        
        npm start 2>&1 | tee "$log_file"
    fi
}

# 停止服务
stop_service() {
    log "停止IEG服务管理器..."
    
    # 查找并停止进程
    local pids=$(pgrep -f "node.*server.js" || true)
    if [ -n "$pids" ]; then
        echo "$pids" | while read -r pid; do
            info "停止进程: $pid"
            kill "$pid" 2>/dev/null || true
        done
        sleep 2
        
        # 强制停止仍在运行的进程
        pids=$(pgrep -f "node.*server.js" || true)
        if [ -n "$pids" ]; then
            echo "$pids" | while read -r pid; do
                warn "强制停止进程: $pid"
                kill -9 "$pid" 2>/dev/null || true
            done
        fi
        
        success "服务已停止"
    else
        info "没有找到运行中的服务"
    fi
}

# 检查服务状态
check_status() {
    info "检查服务状态..."
    
    local pids=$(pgrep -f "node.*server.js" || true)
    if [ -n "$pids" ]; then
        success "服务正在运行，PID: $pids"
        
        # 检查端口监听
        if netstat -tuln 2>/dev/null | grep -q ":$PORT "; then
            success "服务正在监听端口: $PORT"
            info "访问地址: http://localhost:$PORT"
            
            # 检查API健康状态
            if command -v curl >/dev/null 2>&1; then
                local health_response=$(curl -s "http://localhost:$PORT$API_PREFIX/health" 2>/dev/null || echo "")
                if [ -n "$health_response" ]; then
                    success "API健康检查通过"
                    if command -v jq >/dev/null 2>&1; then
                        echo "$health_response" | jq . 2>/dev/null || echo "$health_response"
                    else
                        echo "$health_response"
                    fi
                else
                    warn "API健康检查失败"
                fi
            fi
        else
            warn "服务进程存在但未监听预期端口"
        fi
    else
        info "服务未运行"
    fi
}

# 运行测试
run_tests() {
    log "运行基础功能测试..."
    cd "$BASE_DIR"
    
    # 测试Node.js语法
    if node -c server.js; then
        success "服务器代码语法检查通过"
    else
        error "服务器代码语法错误"
        return 1
    fi
    
    # 测试npm脚本
    if npm run test >/dev/null 2>&1; then
        success "npm测试通过"
    else
        warn "npm测试失败或未定义"
    fi
}

# 显示使用说明
show_usage() {
    echo -e "${PURPLE}IEG服务管理器启动脚本${NC}"
    echo ""
    echo "用法: $0 [选项]"
    echo ""
    echo "选项:"
    echo "  --setup        初始化项目结构和安装依赖"
    echo "  --start        启动服务 (默认)"
    echo "  --dev          开发模式启动"
    echo "  --stop         停止服务"
    echo "  --restart      重启服务"
    echo "  --status       检查服务状态"
    echo "  --test         运行基础测试"
    echo "  --port PORT    指定端口 (默认: 3008)"
    echo "  --help         显示此帮助信息"
    echo ""
    echo "环境变量:"
    echo "  PORT          服务端口 (默认: 3008)"
    echo "  NODE_ENV      运行环境 (production/development)"
    echo ""
    echo "示例:"
    echo "  $0 --setup          # 初始化项目"
    echo "  $0 --start          # 启动服务"
    echo "  $0 --dev            # 开发模式启动"
    echo "  $0 --port 8080      # 指定端口启动"
    echo "  $0 --status         # 检查运行状态"
    echo ""
    echo "API端点:"
    echo "  GET  $API_PREFIX/health              # 健康检查"
    echo "  GET  $API_PREFIX/services            # 服务列表"
    echo "  POST $API_PREFIX/services/reload     # 重新加载配置"
    echo "  POST $API_PREFIX/services/{id}/execute/{script}  # 执行脚本"
}

# 主函数
main() {
    local action="${1:-start}"
    
    case "$action" in
        --setup|setup)
            check_dependencies
            create_project_structure
            install_dependencies
            validate_service_config
            create_service_config
            success "项目初始化完成!"
            info "现在可以运行: $0 --start"
            ;;
        --start|start)
            check_dependencies
            create_project_structure
            install_dependencies
            validate_service_config
            start_service
            ;;
        --dev|dev)
            NODE_ENV="development"
            check_dependencies
            create_project_structure
            install_dependencies
            validate_service_config
            start_service
            ;;
        --stop|stop)
            stop_service
            ;;
        --restart|restart)
            stop_service
            sleep 2
            check_dependencies
            create_project_structure
            install_dependencies
            validate_service_config
            start_service
            ;;
        --status|status)
            check_status
            ;;
        --test|test)
            run_tests
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

# 脚本入口点
if [ $# -eq 0 ]; then
    main start
else
    main "$@"
fi
