import net from 'net';
import LifeRaft from '@markwylde/liferaft';

class DiskeyvalRaft extends LifeRaft {
   initialize (options) {
    this.server = net.createServer((socket) => {
      socket.on('data', buffer => {
        const data = JSON.parse(buffer.toString());

        this.emit('data', data, data => {
          socket.write(JSON.stringify(data));
          socket.end();
        });
      });
    }).listen(options.port);

    this.once('end', () => {
      this.server.close();
    });
  }

  write (packet, fn) {
    const [host, port] = this.address.split(':');
    const socket = net.connect(port, host);

    socket.on('error', fn);
    socket.on('data', buffer => {
      let data;

      try {
        data = JSON.parse(buffer.toString());
      } catch (error) {
        return fn(error);
      }

      fn(undefined, data);
    });

    socket.setNoDelay(true);
    socket.write(JSON.stringify(packet));
  }
}


const createDiskeyval = (options) => {
  const raft = new DiskeyvalRaft({
    'election min': 200,
    'election max': 1000,
    heartbeat: 150,
    ...options
  });

  return raft;
}

export default createDiskeyval;
