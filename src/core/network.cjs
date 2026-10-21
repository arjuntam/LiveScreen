'use strict';
const os = require('node:os');
function ipv4(ip) { return ip?.replace(/^::ffff:/, ''); }
function privateIP(ip) {
  const p = ip?.split('.').map(Number);
  return p?.length === 4 && p.every(x => Number.isInteger(x) && x >= 0 && x <= 255) &&
    (p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31));
}
const integer = ip => ip.split('.').reduce((v, n) => ((v << 8) | Number(n)) >>> 0, 0);
function sameSubnet(ip, address, netmask) { return (integer(ip) & integer(netmask)) === (integer(address) & integer(netmask)); }
function interfaces() {
  const all = Object.entries(os.networkInterfaces()).flatMap(([name, entries]) => entries
    .filter(a => a.family === 'IPv4' && !a.internal && privateIP(a.address))
    .map(a => ({ name, address: a.address, netmask: a.netmask })));
  return [...new Map(all.map(a => [a.address, a])).values()];
}
module.exports = { ipv4, privateIP, sameSubnet, interfaces };
