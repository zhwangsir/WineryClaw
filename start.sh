#!/bin/bash
set -e

echo "========================================"
echo "     WeBrain 启动脚本"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo "Error: Please run this script from the project root directory"
    exit 1
fi

echo -e "${BLUE}[1/4]${NC} 检查环境..."

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "Error: Python3 is not installed"
    exit 1
fi

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed"
    exit 1
fi

echo -e "${GREEN}✓${NC} 环境检查通过"
echo ""

echo -e "${BLUE}[2/4]${NC} 启动主脑 (Main Brain)..."
cd sub-brain/main-brain
if [ ! -d "venv" ]; then
    echo "创建 Python 虚拟环境..."
    python3 -m venv venv
fi
source venv/bin/activate
pip install -r requirements.txt -q
nohup python main_brain.py > ../../logs/main-brain.log 2>&1 &
echo $! > ../../logs/main-brain.pid
cd ../..
echo -e "${GREEN}✓${NC} 主脑已启动"
echo ""

echo -e "${BLUE}[3/4]${NC} 启动副脑 (Sub Brain)..."
cd sub-brain
if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    npm install
fi
npm run build
nohup npm start > ../logs/sub-brain.log 2>&1 &
echo $! > ../logs/sub-brain.pid
cd ..
echo -e "${GREEN}✓${NC} 副脑已启动"
echo ""

echo -e "${BLUE}[4/4]${NC} 启动前端..."
cd frontend
if [ ! -d "node_modules" ]; then
    echo "安装依赖..."
    npm install
fi
npm run dev &
echo $! > ../logs/frontend.pid
cd ..
echo -e "${GREEN}✓${NC} 前端已启动"
echo ""

echo "========================================"
echo -e "${GREEN}所有服务已启动!${NC}"
echo "========================================"
echo ""
echo -e "${YELLOW}服务地址:${NC}"
echo "  前端:     http://localhost:8587"
echo "  副脑 API: http://localhost:3456"
echo "  主脑 API: http://localhost:18790"
echo ""
echo -e "${YELLOW}日志文件:${NC}"
echo "  主脑:     logs/main-brain.log"
echo "  副脑:     logs/sub-brain.log"
echo ""
echo -e "${YELLOW}停止服务:${NC}"
echo "  ./stop.sh"
echo ""
