# 智能应用代理服务器

这是一个基于 Node.js 的智能代理应用程序，可以根据应用程序名称自动将流量转发到指定的代理服务器。它能够智能识别不同应用的网络请求，并根据配置将其转发到不同的代理服务器。

## 主要特性

- **智能代理路由**：根据应用程序名称自动将流量转发到指定的代理服务器
- **应用识别**：通过 lsof 命令识别发起请求的应用程序名称
- **系统代理集成**：自动配置和管理系统代理设置
- **实时监控**：内置 Dashboard 监控请求状态和应用流量
- **热重载配置**：支持配置文件热重载，无需重启服务
- **优雅退出**：自动清理系统代理设置和活动连接
- **详细日志**：多级别日志记录，支持文件和控制台输出
- **高性能**：使用 Node.js 异步 I/O，支持大量并发连接

## 系统要求

- macOS 操作系统
- Node.js 14.0 或更高版本
- 管理员权限（用于系统代理设置和应用程序识别）

## 安装

### 全局安装（推荐）

```bash
npm install -g app-proxy-nodejs
```

### 本地安装

```bash
git clone [repository-url]
cd app-proxy-nodejs
npm install
```

## 配置

配置文件位于 `~/.app-proxy/config.yml`，首次运行时会自动创建。主要配置项包括：

```yaml
# 服务器配置
server:
  host: "127.0.0.1"    # 监听地址
  port: 8080           # 监听端口
  backlog: 1024        # TCP 连接队列大小
  excluded_services:   # 不设置代理的网络服务
    - "Thunderbolt Bridge"

# 代理应用程序映射配置
proxy_app_map:
  "10.20.30.1:8888":   # 代理服务器地址
    - "com.apple.webkit.networking"  # 应用标识符
    - "code helper (plugin)"
  "127.0.0.1:8081":
    - "firefox"

# 日志配置
logging:
  console:
    enabled: true
    level: info
  file:
    directory: logs
    max_size: 10m
    max_files: 5

# Dashboard配置
dashboard:
  enabled: true
  port: 8081
  host: "127.0.0.1"
```

## 使用方法

### 命令行选项

```bash
app-proxy [options]

选项：
  --port <number>     指定服务器端口
  --open-config       打开配置文件
  -h, --help         显示帮助信息
```

### 启动服务

```bash
# 使用默认配置启动
app-proxy

# 指定端口启动
app-proxy --port 8888

# 打开配置文件
app-proxy --open-config
```

### Dashboard 访问

启动服务后，可以通过浏览器访问 `http://localhost:8081` 查看代理状态和流量统计。

## 日志说明

日志文件默认保存在 `~/.app-proxy/logs` 目录：

- `error.log`: 错误日志
- `warning.log`: 警告日志
- `combined.log`: 综合日志

## 常见问题

1. **获取应用名称失败**
   - 检查 lsof 命令是否可用

2. **端口被占用**
   - 使用 `--port` 参数指定其他端口
   - 检查并关闭占用端口的程序

3. **系统代理设置失败**
   - 检查网络设置是否被其他程序锁定

## 注意事项

1. 修改配置文件后会自动重载服务
1. 关闭程序时会自动清理系统代理设置
1. 建议将频繁访问的应用添加到代理映射中

## 许可证

MIT License
