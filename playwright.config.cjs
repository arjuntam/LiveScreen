const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({ testDir: './tests/ui', timeout: 60000, workers: 1, reporter: [['list'], ['html', { open: 'never' }]], use: { trace: 'retain-on-failure' } });
