# Distrugree

## Installation
```
npm install --save distrugree
```

## Target Example
> This is a work in progress. It doesn't work just yet.

```javascript
import distrugree from 'distrugree';

const node1 = distrugree({
  host: '0.0.0.0',
  port: 8050
})

const node2 = distrugree({
  host: '0.0.0.0',
  port: 8051
})

node1.join('localhost:8051');
node2.join('localhost:8050');

await node1.set('testkey', 'testvalue1');
node1.state.testkey === 'testvalue1';

node1.watch('testkey', value => {
  console.log('testkey changed to', value);
});

node1.end();
node2.end();
```
