const si = require('systeminformation');

async function test() {
  try {
    const net = await si.networkStats();
    console.log('networkStats:', JSON.stringify(net, null, 2));

    const load = await si.currentLoad();
    console.log('currentLoad:', JSON.stringify(load, null, 2));

    const cpu = await si.cpu();
    console.log('cpu:', JSON.stringify(cpu, null, 2));

    const procs = await si.processes();
    console.log('processes total:', procs.all);
    console.log('process sample:', JSON.stringify(procs.list.slice(0, 2), null, 2));

  } catch (e) {
    console.error(e);
  }
}

test();
