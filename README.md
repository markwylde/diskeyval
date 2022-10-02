# Distrugree

## Installation
```
npm install --save distrugree
```

## Target Example
> This is a work in progress. It doesn't work just yet.

```javascript
import createDistrugree from 'distrugree';

const distrugree = createDistrugree({
  host: '0.0.0.0',
  port: '8050'
});

distrugree.join('localhost:8053');

await distrugree.sendToLeader('SET', 'testkey', 'testvalue') === ['SUCCESS'];

await distrugree.sendToRandom('GET', 'testkey') === ['SUCCESS', 'testvalue'];

await distrugree.sendToAll('GET', 'testkey') === [
  ['SUCCESS', 'testvalue'],
  ['SUCCESS', 'testvalue'],
  ['SUCCESS', 'testvalue']
];

distrugree.end();
```
