'use strict';
const base = require('../package.json').build;
module.exports = {
  ...base,
  appId: 'local.livescreen.player', productName: 'LiveScreen',
  extraMetadata: { livescreenPreview: false },
  directories: { output: 'dist/mac' },
  mac: {
    identity: '-', category: 'public.app-category.utilities', icon: 'assets/livescreen.icns',
    artifactName: 'LiveScreen-Mac-${version}-${arch}.${ext}',
    target: [{ target: 'zip', arch: ['arm64'] }],
    extendInfo: { NSLocalNetworkUsageDescription: 'LiveScreen 需要通过局域网连接手机控制页和远程管理页。' }
  }
};
