package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"serverless/dev-mode-extension/lib"
	"strings"
	"time"

	tags "go.buf.build/protocolbuffers/go/serverless/sdk-schema/serverless/instrumentation/tags/v1"
	schema "go.buf.build/protocolbuffers/go/serverless/sdk-schema/serverless/instrumentation/v1"
	"google.golang.org/protobuf/proto"
)

type APIPayload struct {
	Payload []byte `json:"payload"`
}

type LogMessage struct {
	Message    string `json:"message"`
	Timestamp  int64  `json:"timestamp"`
	SequenceId string `json:"sequenceId"`
	AccountId  string `json:"accountId"`
	RequestId  string `json:"requestId"`
}

type LogItem struct {
	Time    string      `json:"time"`
	LogType string      `json:"type"`
	Record  interface{} `json:"record"`
}

func FindRequestId(logs []LogItem) string {
	var requestId string = ""
	for _, log := range logs {
		if log.LogType == "platform.start" {
			record := log.Record.(map[string]interface{})
			requestId = record["requestId"].(string)
			break
		}
	}
	return requestId
}

func FormatLogs(logs []LogItem, requestId string, accountId string) schema.LogPayload {
	messages := make([]*schema.LogEvent, 0)
	platform := "aws"
	region := os.Getenv("AWS_REGION")
	slsTags := tags.SlsTags{
		OrgId:    os.Getenv("SLS_DEV_MODE_ORG_ID"),
		Platform: &platform,
		Region:   &region,
		Service:  os.Getenv("AWS_LAMBDA_FUNCTION_NAME"),
	}
	payload := schema.LogPayload{
		SlsTags:   &slsTags,
		LogEvents: messages,
	}
	for _, log := range logs {
		if log.LogType == "function" {
			t, _ := time.Parse(time.RFC3339, log.Time)
			if !strings.Contains(log.Record.(string), "SERVERLESS_TELEMETRY.") {
				logGroup := os.Getenv("AWS_LAMBDA_LOG_GROUP_NAME")
				logStream := os.Getenv("AWS_LAMBDA_LOG_STREAM_NAME")
				traceId := ""
				messages = append(messages, &schema.LogEvent{
					Message:    log.Record.(string),
					Timestamp:  uint64(t.UnixMilli()),
					SequenceId: "",
					LogGroup:   &logGroup,
					LogStream:  &logStream,
					AccountId:  &accountId,
					RequestId:  &requestId,
					TraceId:    &traceId,
				})
			}
		}
	}
	payload.LogEvents = messages
	return payload
}

func ForwardLogs(logs []LogItem, requestId string, accountId string) (int, error) {
	logPayload := FormatLogs(logs, requestId, accountId)
	if len(logPayload.LogEvents) == 0 {
		return 0, nil
	}

	// Convert proto to bytes
	protoBytes, protoErr := proto.Marshal(&logPayload)
	if protoErr != nil {
		fmt.Println("Failed to marshal proto", protoErr)
	}

	// Add proto to json payload
	jsonData := APIPayload{
		Payload: protoBytes,
	}

	// Stringify json
	body, err := json.Marshal(jsonData)
	if err != nil {
		return 0, err
	}

	// Send data to backends
	var _, internalLogsOnly = os.LookupEnv("SLS_TEST_EXTENSION_INTERNAL_LOG")
	var _, toLogs = os.LookupEnv("SLS_TEST_EXTENSION_LOG")
	// If we are running integration tests we just want to write the JSON payloads to CW
	if toLogs {
		lib.ReportLog(string(body))
		return 200, nil
	} else {
		url := "https://core.serverless.com/api/ingest/forwarder"
		// If we are running unit tests we want to publish logs to the local testing server
		if internalLogsOnly {
			extensions_api_address, ok := os.LookupEnv("AWS_LAMBDA_RUNTIME_API")
			if !ok {
				fmt.Println("AWS_LAMBDA_RUNTIME_API is not set")
			}
			url = fmt.Sprintf("http://%s/logs/save", extensions_api_address)
		}
		var _, isDev = os.LookupEnv("SERVERLESS_PLATFORM_STAGE")
		if isDev {
			url = "https://core.serverless-dev.com/api/ingest/forwarder"
		}
		res, resErr := http.Post(url, "application/json", bytes.NewBuffer(body))
		return res.StatusCode, resErr
	}
}