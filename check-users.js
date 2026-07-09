const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.user.findMany({ select: { id: true, email: true, walletAddress: true, role: true, displayName: true } })
  .then(r => { console.log(JSON.stringify(r, null, 2)); return p.$disconnect(); })
  .catch(e => { console.error(e.message); return p.$disconnect(); });
