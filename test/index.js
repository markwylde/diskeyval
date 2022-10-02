import test from 'basictap';

import createDiskeyval from '../lib/index.js';

const fastOptionsForTest = {
  'election min': 100,
  'election max': 500,
  heartbeat: 100,
}

test('connects and closes', t => {
  const diskeyval = createDiskeyval({
    ...fastOptionsForTest,
    host: '127.0.0.1',
    port: 8050
  });

  diskeyval.end();
});

test('elects a leader with 1 other node', t => {
  t.plan(1);

  const diskeyval1 = createDiskeyval({
    ...fastOptionsForTest,
    host: '127.0.0.1',
    port: 8050
  });

  const diskeyval2 = createDiskeyval({
    ...fastOptionsForTest,
    host: '127.0.0.1',
    port: 8051
  });

  diskeyval1.join('127.0.0.1:8051');
  diskeyval2.join('127.0.0.1:8050');

  diskeyval1.on('leader change', () => {
    setTimeout(() => {
      diskeyval1.end();
      diskeyval2.end();

      t.pass('leader was elected');
    });
  });
});
