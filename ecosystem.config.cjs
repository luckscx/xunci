// PM2 生产配置：由 scripts/deploy-claw.sh 同步到 Claw 的 /data/ciwen 后启动。
// 端口与 deploy-claw.sh 的 PORT 保持一致；只监听环回，外部一律经 Nginx 访问。
module.exports = {
  apps: [
    {
      name: 'ciwen',
      cwd: __dirname,
      script: 'server/index.js',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3110',
      },
      max_memory_restart: '800M',
    },
  ],
}
