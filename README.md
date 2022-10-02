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
    port,

    actions: {
      SET: (key, value, response) => {
        if (!node.isLeader) {
          response.forwardToLeader();
          return;
        }

        node.mergeState({
          [key]: value
        });

        response.send('SUCCESS');
      },

      GET: (key, value, response) => {
        response.send('SUCCESS', node.state[key]);
      }
    }
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
