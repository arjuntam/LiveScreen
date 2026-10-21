'use strict';
const base = require('../package.json').build;
module.exports = {
  ...base, appId: 'local.livescreen.preview', productName: 'LiveScreen Preview',
  extraMetadata: { livescreenPreview: true },
  directories: { output: 'dist/mac-preview' },
  mac: { identity: null, category: 'public.app-category.utilities', icon: 'assets/livescreen.icns', target: [{ target: 'dir', arch: ['arm64'] }] }
};
