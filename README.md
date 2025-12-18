# VideoHub Simulator

A cross-platform Electron application that simulates a Blackmagic VideoHub router. Perfect for testing VideoHub control software, developing integrations, or training purposes without requiring physical hardware.

![VideoHub Simulator Screenshot](docs/screenshot.png)

## Features

- **Full VideoHub Protocol Support** - Implements Blackmagic's Ethernet Protocol v2.8
- **Configurable Router Size** - Simulate routers from 12x12 up to 288x288
- **Multiple Model Presets** - Smart Videohub 12x12, 20x20, 40x40, Universal Videohub 72/288
- **Real-time Routing Matrix** - Interactive UI to view and change routes
- **Editable Labels** - Customize input and output names
- **Pre-populated Labels** - Comes with TV station/edit suite example names
- **Multi-client Support** - Multiple control applications can connect simultaneously
- **Live Activity Log** - Monitor all protocol commands and client connections

## Installation

### Prerequisites

- Node.js 18 or later
- npm

### Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/videohub-simulator.git
cd videohub-simulator

# Install dependencies
npm install

# Start the application
npm start
```

## Usage

1. **Start the Application** - Run `npm start`
2. **Start the Server** - Click the "Start Server" button to begin listening on port 9990
3. **Connect Clients** - Point your VideoHub control software to `localhost:9990` (or your machine's IP address)
4. **Control Routes** - Use either the simulator UI or connected clients to change routes

### Configuration Options

| Setting | Description |
|---------|-------------|
| Model Name | Select a VideoHub model preset |
| Friendly Name | Custom name reported to clients |
| Inputs | Number of input ports (1-288) |
| Outputs | Number of output ports (1-288) |
| TCP Port | Server port (default: 9990) |

## Protocol Support

The simulator implements the Blackmagic Videohub Ethernet Protocol including:

- `PROTOCOL PREAMBLE` - Version handshake
- `VIDEOHUB DEVICE` - Device information block
- `INPUT LABELS` - Input port naming
- `OUTPUT LABELS` - Output port naming
- `VIDEO OUTPUT ROUTING` - Route assignments
- `VIDEO OUTPUT LOCKS` - Port locking (O/U/L states)
- `PING` / `ACK` - Keep-alive support

### Example Protocol Session

```
PROTOCOL PREAMBLE:
Version: 2.8

VIDEOHUB DEVICE:
Device present: true
Model name: Blackmagic Smart Videohub 12x12
Video inputs: 12
Video outputs: 12

INPUT LABELS:
0 CAM 1
1 CAM 2
...

VIDEO OUTPUT ROUTING:
0 0
1 1
...
```

## Compatible Software

This simulator works with any software that supports the Blackmagic VideoHub protocol:

- Bitfocus Companion
- vMix
- Blackmagic Videohub Control
- Ross DashBoard
- Custom integrations

## Development

```bash
# Run in development mode (with DevTools)
npm run dev
```

### Project Structure

```
videohub-simulator/
├── package.json
├── README.md
├── .gitignore
└── src/
    ├── main.js           # Electron main process
    ├── preload.js        # Preload script for secure IPC
    ├── index.html        # UI and renderer process
    └── videohub-server.js # TCP server with protocol implementation
```

## Troubleshooting

### "ELECTRON_RUN_AS_NODE" Error

If you see errors about Electron running as Node, the start script should handle this automatically. If issues persist, run:

```bash
unset ELECTRON_RUN_AS_NODE && npm start
```

### Port Already in Use

If port 9990 is already in use, either:
- Stop the other application using the port
- Change the port in the simulator's configuration panel

### Connection Refused

Ensure the server is started (green status indicator) before connecting clients.

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- Protocol specification based on [Blackmagic Videohub Developer Information](https://documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf)
