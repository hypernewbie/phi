package piapp

import (
	"context"
	"testing"

	"github.com/hypernewbie/phi/internal/pibridge"
	pibridgepb "github.com/hypernewbie/phi/internal/pibridge/pb"
)

func TestPiSyncboardSubscribeKeepsItsCapturedEpoch(t *testing.T) {
	b := startTestBridgeWith(t, testBridgeHub())
	b.SetSyncboardTopicEpoch("epoch-1")
	_, cancel := dialBridgePane(t, b, "pane", pibridge.CapabilityLifecycle, pibridge.CapabilitySyncboardTopics)
	defer cancel()
	process := paneProcessID(t, b, "pane")
	b.SetSyncboardTopicSubscriber(func(owner pibridge.SyncboardOwner, topic string) error {
		// The coordinator changes after registration but before its response.
		b.SetSyncboardTopicEpoch("epoch-2")
		return nil
	})
	request := &pibridgepb.SyncboardRequest{RequestId: "1", Operation: pibridgepb.SyncboardOperation_SYNCBOARD_OPERATION_SUBSCRIBE, Key: "alerts"}
	first := b.handleSyncboardSubscribe(context.Background(), process, request)
	if first.GetHttpStatus() != 200 || first.GetCoordinatorEpoch() != "epoch-1" || first.GetTopicBindingSeq() == 0 {
		t.Fatal("subscribe response restamped an old binding with a newer coordinator epoch")
	}
	b.SetSyncboardTopicSubscriber(func(pibridge.SyncboardOwner, string) error { return nil })
	second := b.handleSyncboardSubscribe(context.Background(), process, request)
	if second.GetHttpStatus() != 200 || second.GetCoordinatorEpoch() != "epoch-2" || second.GetTopicBindingSeq() <= first.GetTopicBindingSeq() {
		t.Fatal("explicit new-epoch subscribe did not advance the retired binding")
	}
}
