const net = require('net');
const NodeCache = require('node-cache');

class ResourceManager {
    constructor() {
        this.activeConnections = new Set();
        this.portConnections = new Map();
        this.isShuttingDown = false;
        // 用于缓存端口号与应用程序名称的映射关系，避免频繁执行lsof命令
        this.appCache = new NodeCache({ 
            stdTTL: 0,        // 永不过期
            checkperiod: 0,   // 不检查过期项
            useClones: false  // 不克隆值以提高性能
        });
        // 用于缓存应用程序与其访问的远端目标的映射关系
        this.appTargetCache = new NodeCache({
            stdTTL: 60*30,      // 30分钟后过期
            checkperiod: 60,  // 每分钟检查过期项
            useClones: false  // 不克隆值以提高性能
        });

        // 存储连接的最后活跃时间
        this.connectionLastActive = new WeakMap();
        
        // 启动定期检查
        this.startPeriodicCheck();
    }

    startPeriodicCheck() {
        // 每30秒检查一次连接状态
        this.checkInterval = setInterval(() => {
            this.checkConnections();
        }, 30000);
    }

    stopPeriodicCheck() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    checkConnections() {
        const now = Date.now();
        const inactiveTimeout = 5 * 60 * 1000; // 5分钟无活动则认为连接已断开

        for (const socket of this.activeConnections) {
            const lastActive = this.connectionLastActive.get(socket) || now;
            
            // 检查连接是否仍然有效
            if (socket.destroyed || !socket.writable || now - lastActive > inactiveTimeout) {
                try {
                    // 确保在销毁前完成所有待处理的操作
                    if (!socket.destroyed) {
                        socket.end(() => {
                            socket.destroy();
                        });
                    }
                } catch (err) {
                    // 忽略销毁过程中的错误，确保继续清理
                } finally {
                    this.removeConnection(socket);
                }
                continue;
            }

            // 对于仍然活跃的连接，设置TCP保活配置
            try {
                if (socket.writable) {
                    // 配置更激进的TCP保活参数
                    socket.setKeepAlive(true, 1000);
                    socket.setNoDelay(true);
                    
                    // 设置socket级别超时
                    socket.setTimeout(300000, () => {
                        // 超时后主动清理
                        this.removeConnection(socket);
                        socket.destroy();
                    });
                    
                    // 监听错误事件
                    socket.once('error', (err) => {
                        this.removeConnection(socket);
                        socket.destroy();
                    });
                }
            } catch (err) {
                // 如果设置保活失败，安全地清理连接
                try {
                    this.removeConnection(socket);
                    if (!socket.destroyed) {
                        socket.destroy();
                    }
                } catch (cleanupErr) {
                    // 确保即使清理过程出错也不会影响其他连接
                }
            }
        }

        // 检查并清理端口连接映射
        for (const [port, connections] of this.portConnections.entries()) {
            let hasValidConnections = false;
            
            // 检查每个连接的有效性
            for (const socket of connections) {
                if (!socket.destroyed && socket.writable) {
                    hasValidConnections = true;
                } else {
                    connections.delete(socket);
                }
            }

            // 如果端口没有有效连接，清理相关资源
            if (!hasValidConnections || connections.size === 0) {
                const appName = this.appCache.get(port);
                this.portConnections.delete(port);
                this.appCache.del(port);

                // 检查是否需要清理应用级别的缓存
                if (appName) {
                    const hasOtherConnections = Array.from(this.portConnections.keys()).some(p => {
                        const otherAppName = this.appCache.get(p);
                        return otherAppName === appName;
                    });
                    
                    if (!hasOtherConnections) {
                        this.appTargetCache.del(appName);
                    }
                }
            }
        }
    }

    addConnection(socket) {
        this.activeConnections.add(socket);
        this.connectionLastActive.set(socket, Date.now());
        
        const port = socket.remotePort;
        if (port) {
            if (!this.portConnections.has(port)) {
                this.portConnections.set(port, new Set());
            }
            this.portConnections.get(port).add(socket);
        }

        // 监听数据传输，更新最后活跃时间
        socket.on('data', () => {
            this.connectionLastActive.set(socket, Date.now());
        });
    }

    removeConnection(socket) {
        this.activeConnections.delete(socket);
        this.connectionLastActive.delete(socket);
        
        const port = socket.remotePort;
        if (port && this.portConnections.has(port)) {
            const connections = this.portConnections.get(port);
            connections.delete(socket);
            
            if (connections.size === 0) {
                // 获取应用名称
                const appName = this.appCache.get(port);
                
                // 清理端口连接记录
                this.portConnections.delete(port);
                
                // 清理应用名称缓存
                this.appCache.del(port);
                
                // 如果这是应用的最后一个连接，清理目标记录
                if (appName) {
                    const hasOtherConnections = Array.from(this.portConnections.keys()).some(p => {
                        const otherAppName = this.appCache.get(p);
                        return otherAppName === appName;
                    });
                    
                    if (!hasOtherConnections) {
                        this.appTargetCache.del(appName);
                    }
                }
            }
        }
    }

    hasActiveConnections(port) {
        return this.portConnections.has(port) && this.portConnections.get(port).size > 0;
    }

    getCachedAppName(port) {
        if (this.hasActiveConnections(port)) {
            return this.appCache.get(port);
        }
        return null;
    }

    setCachedAppName(port, appName) {
        if (this.hasActiveConnections(port)) {
            this.appCache.set(port, appName);
        }
    }

    closeConnections() {
        for (const socket of this.activeConnections) {
            socket.end();
        }
    }

    forceCloseConnections() {
        for (const socket of this.activeConnections) {
            socket.destroy();
        }
    }

    cleanup() {
        this.stopPeriodicCheck();
        this.portConnections.clear();
        this.appCache.close();
        this.appTargetCache.close();
        this.connectionLastActive = new WeakMap();
    }

    get connectionsCount() {
        return this.activeConnections.size;
    }

    // 获取指定端口的连接统计信息
    getConnectionStats(port) {
        if (!this.portConnections.has(port)) {
            return null;
        }

        const connections = this.portConnections.get(port);
        const total = connections.size;
        const idle = 0; // 目前没有实现空闲连接的统计，默认为0
        const avgIdleTime = 0; // 目前没有实现空闲时间的统计，默认为0

        return {
            total,
            idle,
            avgIdleTime
        };
    }

    // 记录应用访问的远端目标
    recordAppTarget(appName, target, success = true) {
        if (!appName || !target) return;
        
        let targets = this.appTargetCache.get(appName) || new Set();
        const targetKey = JSON.stringify(target); // 用于排重的键
        
        // 移除相同目标的旧记录
        const existingTargets = Array.from(targets).map(t => JSON.parse(t));
        targets = new Set(existingTargets
            .filter(t => JSON.stringify(t.target) !== targetKey)
            .map(t => JSON.stringify(t)));
        
        // 添加新记录
        const targetWithStatus = {
            target,
            success,
            timestamp: Date.now()
        };
        targets.add(JSON.stringify(targetWithStatus));
        this.appTargetCache.set(appName, targets);
    }

    // 获取应用访问的所有远端目标
    getAppTargets(appName) {
        if (!appName) return [];
        const targets = this.appTargetCache.get(appName);
        if (!targets) return [];
        return Array.from(targets)
            .map(t => JSON.parse(t))
            .sort((a, b) => b.timestamp - a.timestamp); // 按时间戳降序排序
    }

    // 获取所有应用的目标映射
    getAllAppTargets() {
        const result = new Map();
        const apps = this.appCache.keys();
        
        for (const appName of apps) {
            const targets = this.getAppTargets(appName);
            if (targets.length > 0) {
                result.set(appName, targets);
            }
        }
        
        return result;
    }
}

module.exports = ResourceManager; 