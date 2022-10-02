# Distrugree

## Installation
```
npm install --save distrugree
```

## Target Example
> This is a work in progress. It doesn't work just yet.

```javascript
import distrugree from 'distrugree';

function createNode (port) {
  const node = distrugree({
    host: '0.0.0.0',
    port
  });

  node.on('SET', (key, value, reply) => {
    node.mergeState({
      [key]: value
    });

    reply('SUCCESS');
  });

  node.on('GET', (key, value, reply) => {
    reply('SUCCESS', node.state[key]);
  });

  return node;
}

const node1 = createNode('8050')
const node2 = createNode('8051')

node1.join('localhost:8051');
node2.join('localhost:8050');

await node1.sendToLeader('SET', 'testkey', 'testvalue') === ['SUCCESS'];

await node1.sendToRandom('GET', 'testkey') === ['SUCCESS', 'testvalue'];

await node1.sendToAll('GET', 'testkey') === [
  ['SUCCESS', 'testvalue'],
  ['SUCCESS', 'testvalue'],
  ['SUCCESS', 'testvalue']
];

distrugree.end();
```
