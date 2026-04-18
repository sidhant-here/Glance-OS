import si from 'systeminformation';
import fs from 'fs';
si.processes().then(p => {
    fs.writeFileSync('./procs_temp.json', JSON.stringify(p.list.slice(0,3), null, 2));
});
