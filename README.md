# Router Protocol Simulator

A cross-platform Electron application that simulates broadcast video routers. Supports multiple protocols including Blackmagic VideoHub and SW-P-08 (Probel/Grass Valley). Perfect for testing router control software, developing integrations, or training purposes without requiring physical hardware.

## Download

**[Download Latest Release (v2.0.3)](https://github.com/videojedi/VideoHubSim/releases/latest)**

| Platform | Download |
|----------|----------|
| macOS (Intel + Apple Silicon) | [Router Protocol Simulator-2.0.3-universal.dmg](https://github.com/videojedi/VideoHubSim/releases/download/v2.0.3/Router.Protocol.Simulator-2.0.3-universal.dmg) |
| Windows Installer | [Router Protocol Simulator Setup 2.0.3.exe](https://github.com/videojedi/VideoHubSim/releases/download/v2.0.3/Router.Protocol.Simulator.Setup.2.0.3.exe) |
| Windows Portable | [Router Protocol Simulator 2.0.3.exe](https://github.com/videojedi/VideoHubSim/releases/download/v2.0.3/Router.Protocol.Simulator.2.0.3.exe) |

## Features

- **Multiple Protocol Support** - Switch between VideoHub, SW-P-08, and GV Native protocols
- **Configurable Router Size** - Simulate routers from 12x12 up to 288x288
- **Custom TCP Port** - Configure the server port for each protocol
- **Real-time Routing Matrix** - Interactive UI to view and change routes
- **Editable Labels** - Customize input and output names
- **Pre-populated Labels** - Comes with TV station/edit suite example names
- **Multi-level Support** - SW-P-08 matrix levels (video, audio, etc.)
- **Multi-client Support** - Multiple control applications can connect simultaneously
- **Persistent Settings** - Configuration saved across app restarts
- **Auto-start Option** - Server can start automatically on launch
- **Live Activity Log** - Monitor all protocol commands and client connections
- **XY Crosspoint Grid** - Visual crosspoint matrix view for intuitive routing

## Supported Protocols

### Blackmagic VideoHub
- TCP port 9990 (default, configurable)
- Text-based protocol v2.8
- Full support for routing, labels, and locks
- Compatible with all VideoHub control software

### SW-P-08 (Probel/Grass Valley)
- TCP port 8910 (default, configurable)
- Binary protocol with DLE/STX framing
- Standard and extended (16-bit) addressing
- Crosspoint routing and interrogation
- Source/destination name queries
- Multi-level matrix support

### GV Native (Series 7000)
- TCP port 12345 (default, configurable)
- Grass Valley native protocol for Series 7000 routers
- Multi-level matrix support

## Installation

### Pre-built Binaries (Recommended)

Download the appropriate installer for your platform from the [releases page](https://github.com/videojedi/VideoHubSim/releases/latest).

### Building from Source

#### Prerequisites

- Node.js 16 or later
- npm

#### Setup

```bash
# Clone the repository
git clone https://github.com/videojedi/VideoHubSim.git
cd VideoHubSim

# Install dependencies
npm install

# Start the application
npm start

# Build for your platform
npm run build:mac   # macOS
npm run build:win   # Windows
```

## Usage

1. **Select Protocol** - Choose VideoHub or SW-P-08 from the Protocol dropdown
2. **Configure Router** - Set the number of inputs/outputs, TCP port, and other options
3. **Start the Server** - Click "Start Server" to begin listening
4. **Connect Clients** - Point your control software to the appropriate port

### Configuration Options

| Setting | Description |
|---------|-------------|
| Protocol | VideoHub, SW-P-08, or GV Native |
| Model Name | Device model reported to clients (VideoHub only) |
| Friendly Name | Custom name reported to clients |
| Inputs | Number of input ports (1-288) |
| Outputs | Number of output ports (1-288) |
| TCP Port | Server port (default: VideoHub 9990, SW-P-08 8910, GV Native 12345) |
| Matrix Levels | Number of levels for SW-P-08/GV Native (video, audio, etc.) |
| Auto-start | Automatically start server when app launches |

## Protocol Details

### VideoHub Protocol

The simulator implements the Blackmagic Videohub Ethernet Protocol including:

- `PROTOCOL PREAMBLE` - Version handshake
- `VIDEOHUB DEVICE` - Device information block
- `INPUT LABELS` - Input port naming
- `OUTPUT LABELS` - Output port naming
- `VIDEO OUTPUT ROUTING` - Route assignments
- `VIDEO OUTPUT LOCKS` - Port locking (O/U/L states)
- `PING` / `ACK` - Keep-alive support

Example session:
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
```

### SW-P-08 Protocol

The simulator implements the SW-P-08 router control protocol including:

- **Message Framing** - DLE/STX start, BTC, checksum validation
- **Crosspoint Connect** (0x02) - Route source to destination
- **Crosspoint Interrogate** (0x01) - Query current route
- **Crosspoint Tally** (0x03) - Route change notifications
- **Crosspoint Connected** (0x04) - Route confirmation
- **Tally Dump Request** (0x15) - Bulk routing table query
- **Source Names** (0x64/0x6a) - Input label request/response
- **Destination Names** (0x66/0x6b) - Output label request/response
- **Extended Commands** (0x81-0x84, 0xe4-0xeb) - 16-bit addressing for large routers

## Compatible Software

This simulator works with router control software including:

**VideoHub Protocol:**
- Bitfocus Companion
- vMix
- Blackmagic Videohub Control
- Ross DashBoard

**SW-P-08 Protocol:**
- Bitfocus Companion
- Ross Ultrix/Carbonite
- Grass Valley NV Series panels
- Lawo VSM
- Calrec consoles
- Many broadcast automation systems

## Development

```bash
# Run in development mode (with DevTools)
npm run dev
```

### Project Structure

```
VideoHubSim/
├── package.json
├── README.md
├── LICENSE
├── .gitignore
├── build/
│   ├── icon.icns          # macOS icon
│   ├── icon.png           # Windows/Linux icon
│   └── icon.svg           # Source icon
└── src/
    ├── main.js             # Electron main process
    ├── preload.js          # Preload script for secure IPC
    ├── index.html          # UI and renderer process
    ├── videohub-server.js  # VideoHub protocol implementation
    ├── swp08-server.js     # SW-P-08 protocol implementation
    └── gvnative-server.js  # GV Native protocol implementation
```

## Troubleshooting

### "ELECTRON_RUN_AS_NODE" Error

If you see errors about Electron running as Node, the start script should handle this automatically. If issues persist, run:

```bash
unset ELECTRON_RUN_AS_NODE && npm start
```

### Port Already in Use

If the port is already in use, either:
- Stop the other application using the port
- Change the port in the simulator's configuration panel

### Connection Refused

Ensure the server is started (green status indicator) before connecting clients.

### SW-P-08 Connection Issues

- Ensure your client is configured for TCP (not serial)
- Default port is 8910
- Some clients may require specifying matrix/level 0

## Changelog

### v2.0.3
- Simplified architecture: Simulator and controller now fully independent
- View toggle switches between simulator and controller display
- Start simulator and connect controller in any combination
- Controller defaults to localhost (127.0.0.1) for easy local testing
- Collapsible activity log panel with disclosure triangle
- XY grid now fills the available panel space
- Header shows both SIM and CTL status indicators
- Removed "Dual Test" mode (no longer needed)

### v2.0.2
- Added destination lock support for BlackMagic VideoHub protocol
- Lock/unlock buttons in routing grid and XY crosspoint view
- Visual lock status indicators (red=locked by you, orange=locked by other)
- Force unlock with Shift+click for destinations locked by other clients
- NAK response handling reverts crosspoint to previous state
- Lock status changes shown in activity log

### v2.0.1
- Added Dual Test mode for local controller testing

### v2.0.0
- Major refactoring: Protocol logic separated into dedicated controller modules
- UI improvements and layout enhancements
- Cleaner code architecture for better maintainability

### v1.3.1
- XY grid: Hover highlights row and column headers
- XY grid: Click-and-drag for sequential 1:1 routing (diagonal or vertical)

### v1.3.0
- Added GV Native (Series 7000) protocol support
- Added XY crosspoint grid view for visual matrix routing
- Model selection now auto-populates input/output counts

### v1.2.1
- Decode SW-P-08 command names in activity log

### v1.2.0
- Add destination and input numbers to routing matrix display

### v1.1.1
- Fixed TCP port configuration not being applied

### v1.1.0
- Added funky router-style app icon
- Fixed port field not being editable

### v1.0.0
- Initial release
- VideoHub protocol support
- SW-P-08 protocol support with multi-level matrix
- Persistent settings
- Auto-start option

## License

MIT License - See [LICENSE](LICENSE) for details.

## Acknowledgments

- VideoHub protocol based on [Blackmagic Videohub Developer Information](https://documents.blackmagicdesign.com/DeveloperManuals/VideohubDeveloperInformation.pdf)
- SW-P-08 protocol based on [Grass Valley SW-P-88 Router Control Protocols](https://wwwapps.grassvalley.com/docs/Manuals/sam/Protocols%20and%20MIBs/Router%20Control%20Protocols%20SW-P-88%20Issue%204b.pdf)
- SW-P-08 implementation informed by [Bitfocus Companion Generic SWP08 Module](https://github.com/bitfocus/companion-module-generic-swp08)
