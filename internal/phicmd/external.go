package phicmd

import (
	"fmt"
	"strings"

	wspb "github.com/hypernewbie/phi/pkg/ws/pb"
)

// externalValueText flattens one external value (string, number, list,
// object) into readable text for transcript rendering.
func externalValueText(v *wspb.ExternalValue) string {
	if v == nil {
		return ""
	}
	var sb strings.Builder
	writeExternal(&sb, v, 0)
	return sb.String()
}

func writeExternal(sb *strings.Builder, v *wspb.ExternalValue, depth int) {
	if v == nil || depth > 8 {
		return
	}
	switch kind := v.GetKind().(type) {
	case *wspb.ExternalValue_StringValue:
		sb.WriteString(kind.StringValue)
	case *wspb.ExternalValue_NumberValue:
		sb.WriteString(fmt.Sprintf("%g", kind.NumberValue))
	case *wspb.ExternalValue_IntValue:
		sb.WriteString(fmt.Sprintf("%d", kind.IntValue))
	case *wspb.ExternalValue_BoolValue:
		sb.WriteString(fmt.Sprintf("%t", kind.BoolValue))
	case *wspb.ExternalValue_ListValue:
		for _, item := range kind.ListValue.GetValues() {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			writeExternal(sb, item, depth+1)
		}
	case *wspb.ExternalValue_ObjectValue:
		for _, entry := range kind.ObjectValue.GetEntries() {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(entry.GetKey())
			sb.WriteString(": ")
			writeExternal(sb, entry.GetValue(), depth+1)
		}
	}
}
