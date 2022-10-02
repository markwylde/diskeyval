# diskeyval

## Installation
```
npm install --save diskeyval
```

## Target Example
> This is a work in progress. It doesn't work just yet.

```javascript
import diskeyval from 'diskeyval';

const node1 = diskeyval({ host: '0.0.0.0', port: 8050 });
const node2 = diskeyval({ host: '0.0.0.0', port: 8051 });

node1.join('localhost:8051');
node2.join('localhost:8050');

await node1.set('testkey', 'testvalue1');
node1.state.testkey === 'testvalue1';
node2.state.testkey === 'testvalue1';

node1.on('change', value => {
  console.log('state has changed');
});

node1.end();
node2.end();
```
