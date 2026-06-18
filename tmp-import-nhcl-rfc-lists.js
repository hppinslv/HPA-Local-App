const fs = require('fs');
const svc = require('./services/analysisService');

const nhclBase = fs.readFileSync("NHCL SCF's_2025.10.xlsx").toString('base64');
const rfcBase = fs.readFileSync("RFC SCF's_2025.10.xlsx").toString('base64');

const nh = svc.importReferenceList({
  listType: 'nhcl',
  fileName: "NHCL SCF's_2025.10.xlsx",
  base64Content: nhclBase,
  actor: 'Local User',
});
const rf = svc.importReferenceList({
  listType: 'rfc',
  fileName: "RFC SCF's_2025.10.xlsx",
  base64Content: rfcBase,
  actor: 'Local User',
});

console.log(JSON.stringify({ nh, rf }, null, 2));
