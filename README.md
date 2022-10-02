# Distrugree

## Installation
```
npm install --save distrugree
```

## Target Example
> This is a work in progress. It doesn't work just yet.

```javascript
import distrugree from 'distrugree';

const createNode = (port) =>
  distrugree({
    host: '0.0.0.0',
    port,

    actions: {
      HELLO: ({ reply }, name) => {
        reply('SUCCESS', `Hi ${name}`);
      },

      SET: ({ reply, forwardToLeader }, key, value) => {
        if (!node.isLeader) {
          forwardToLeader();
          return;
        }

        node.mergeState({
          [key]: value
        });

        reply('SUCCESS');
      }
    }
  });

const node1 = createNode('8050')
const node2 = createNode('8051')

node1.join('localhost:8051');
node2.join('localhost:8050');

await node1.sendToLeader('SET', 'testkey', 'testvalue1') === ['SUCCESS'];
node1.state.testkey === 'testvalue1';

await node1.sendToRandom('SET', 'testkey', 'testvalue2') === ['SUCCESS'];
node1.state.testkey === 'testvalue2';

await node1.sendToRandom('HELLO', 'Mark') === ['SUCCESS', 'Hi Mark'];

await node1.sendToAll('HELLO', 'Mark') === [
  ['SUCCESS', 'Hi Mark'],
  ['SUCCESS', 'Hi Mark']
];

distrugree.end();
```
