package ws

import (
	"encoding/binary"
	"log"
	"net/http"

	"github.com/hypernewbie/phi/pkg/pty"

	"github.com/gorilla/websocket"
)

var Upgrader = websocket.Upgrader{
	ReadBufferSize:    1024 * 32,
	WriteBufferSize:   1024 * 32,
	EnableCompression: true,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for localhost and SSH tunnels
	},
}

func (c *Client) WritePump() {
	for msg := range c.Send {
		err := c.Ws.WriteMessage(websocket.BinaryMessage, msg)
		if err != nil {
			break
		}
	}
	_ = c.Ws.Close()
}

func (c *Client) ReadPump(inst *pty.PTYInstance, manager *pty.Manager, hub *Hub) {
	defer func() {
		hub.Unregister(inst.ID, c)
		manager.UnregisterWS(inst.ID)
		_ = c.Ws.Close()
	}()

	for {
		mt, message, err := c.Ws.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage || len(message) == 0 {
			continue
		}

		msgType := message[0]
		payload := message[1:]

		switch msgType {
		case 0x01: // PTY stdin data
			_, _ = inst.Pty.Write(payload)
		case 0x02: // Resize
			if len(payload) >= 4 {
				cols := binary.BigEndian.Uint16(payload[0:2])
				rows := binary.BigEndian.Uint16(payload[2:4])
				_ = inst.Pty.Resize(cols, rows)
			}
		case 0x03: // Ping
			c.Send <- []byte{0x03} // Pong
		}
	}
}

func StartPTYReadLoop(inst *pty.PTYInstance, hub *Hub) {
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := inst.Pty.Read(buf)
			if err != nil {
				break
			}
			if n > 0 {
				inst.UpdateActivity()
				hub.Broadcast(inst.ID, 0x01, buf[:n])
			}
		}
	}()
}

func HandleWS(w http.ResponseWriter, r *http.Request, inst *pty.PTYInstance, manager *pty.Manager, hub *Hub) {
	conn, err := Upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[ws] Upgrade error: %v", err)
		return
	}

	client := &Client{
		Ws:   conn,
		Send: make(chan []byte, 16384),
	}

	manager.RegisterWS(inst.ID)
	hub.Register(inst.ID, client)

	go client.WritePump()
	client.ReadPump(inst, manager, hub)
}
