const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.listing.deleteMany({ where: { sellerAddress: 'seed-admin' } })
  .then(r => { console.log('Deleted ' + r.count); return p.$disconnect(); })
  .catch(e => { console.error(e.message); return p.$disconnect(); });
