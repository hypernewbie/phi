// Command syncpush publishes one addressed message to a Phi mesh listener.
//
// It exists so end-to-end specs can drive the real phi.sync.v1 wire protocol
// without a Node gRPC protobuf loader. It prints the assigned sequence on
// success and exits non-zero with the gRPC status on failure.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	syncmeshb "github.com/hypernewbie/phi/internal/syncmesh/pb"
)

func main() {
	addr := flag.String("addr", "", "mesh listener host:port")
	recipient := flag.String("recipient", "", "recipient identity")
	value := flag.String("value", "", "message body")
	messageID := flag.String("message-id", "", "idempotency key (default: value hash)")
	hops := flag.Uint("hops", 0, "relay hop count")
	timeout := flag.Duration("timeout", 10*time.Second, "call deadline")
	flag.Parse()

	if *addr == "" || *recipient == "" || *value == "" {
		exit("addr, recipient, and value are required")
	}
	id := *messageID
	if id == "" {
		id = fmt.Sprintf("e2e-%d-%s", time.Now().UnixNano(), *recipient)
	}

	conn, err := grpc.NewClient(*addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		exit("dial: " + err.Error())
	}
	defer func() { _ = conn.Close() }()

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	resp, err := syncmeshb.NewSyncMeshClient(conn).Publish(ctx, &syncmeshb.PublishRequest{
		MessageId: id,
		Recipient: *recipient,
		Value:     []byte(*value),
		Hops:      uint32(*hops),
	})
	if err != nil {
		exit("publish: " + err.Error())
	}

	out, _ := json.Marshal(map[string]any{
		"seq":        resp.GetSeq(),
		"duplicate":  resp.GetDuplicate(),
		"message_id": id,
	})
	fmt.Println(string(out))
}

func exit(message string) {
	fmt.Fprintln(os.Stderr, "syncpush:", message)
	os.Exit(1)
}
