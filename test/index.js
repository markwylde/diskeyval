import test from 'basictap';

import createDistrugree from '../lib/index.js';

const fastOptionsForTest = {
  'election min': 100,
  'election max': 500,
  heartbeat: 100,
}

test('connects and closes', t => {
  const distrugree = createDistrugree({
    ...fastOptionsForTest,
    host: '127.0.0.1',
    port: 8050
  });

  distrugree.end();
});

test('elects a leader with 1 other node', t => {
  t.plan(1);

  const distrugree1 = createDistrugree({
    ...fastOptionsForTest,
    host: '127.0.0.1',
    port: 8050
  });

  const distrugree2 = createDistrugree({
    ...fastOptionsForTest,
    host: '127.0.0.1',
    port: 8051
  });

  distrugree1.join('127.0.0.1:8051');
  distrugree2.join('127.0.0.1:8050');

  distrugree1.on('leader change', () => {
    setTimeout(() => {
      distrugree1.end();
      distrugree2.end();

      t.pass('leader was elected');
    });
  });
});
