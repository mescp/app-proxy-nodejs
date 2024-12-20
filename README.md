# 智能应用代理服务器

这是一个基于 Node.js 的智能代理应用程序，可以根据应用程序名称自动将流量转发到指定的代理服务器。

## 功能特点

- 智能代理路由：根据应用程序名称自动将流量转发到指定的代理服务器
- 应用识别：通过代理接收到应用的请求端口识别发起请求的应用程序名称
- 缓存机制：内置应用名称与代理路由缓存，提高性能和响应速度
- 灵活配置：支持 YAML 配置文件，易于自定义代理规则
- 详细日志：提供完整的路由决策和错误日志记录
- 应用记录：可选功能，记录所有通过代理的应用程序访问历史
- 优雅退出：自动清理缓存和系统资源

## 安装

```bash
npm install
```

## 配置

编辑 `config.yml` 文件来配置代理规则：

```yaml
# 默认代理配置
default_proxy:
  host: 127.0.0.1
  port: 8081

# 功能配置
features:
  record_apps:
    description: Record all applications that pass through the proxy
    enabled: true

# 代理应用程序映射配置
proxy_app_map:
  "10.20.30.1:8888":
    - "com.apple.webkit.networking"
    - "safari"
  "127.0.0.1:8081":
    - "chrome"
    - "firefox"
```

## 运行

```bash
npm start
```

默认情况下，代理服务器将在端口 8080 上运行。

## 日志

- `error.log`: 记录错误信息
- `combined.log`: 记录所有日志信息

## 注意事项

1. 此代理服务器需要在 macOS 系统上运行
2. 需要适当的系统权限来识别应用程序名称
3. 确保配置文件中的代理服务器地址可用
