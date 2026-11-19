// pm2 process definition. Start or update it with ./deploy.sh.
module.exports = {
  apps: [
    {
      name: "bms-alerts",
      script: "dist/index.js",
      // The app's own watch mode (poll loop). Not pm2's file watcher.
      args: "--watch",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      // Time for the app to close its browser on stop/reload.
      kill_timeout: 10000,
      time: true,
    },
  ],
};
