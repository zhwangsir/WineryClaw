#!/bin/bash
set -e

echo "========================================"
echo "     WeBrain 停止脚本"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

stop_service() {
    local name=$1
    local pid_file=$2
    if [ -f "$pid_file" ]; then
        local pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo -e "${BLUE}停止${name}...${NC}"
            kill "$pid" 2>/dev/null || true
            rm -f "$pid_file"
            echo -e "${GREEN}✓${NC} ${name} 已停止"
        else
            echo -e "${YELLOW}⚠${NC} ${name} 未运行"
            rm -f "$pid_file"
        fi
    else
        echo -e "${YELLOW}⚠${NC} ${name} PID 文件不存在"
    fi
}

stop_service "前端" "logs/frontend.pid"
stop_service "副脑" "logs/sub-brain.pid"
stop_service "主脑" "logs/main-brain.pid"

echo ""
echo -e "${GREEN}所有服务已停止!${NC}"
echo "========================================"
