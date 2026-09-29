package main

import (
	"context"
	"encoding/json"
	"fmt"
	sdk "github.com/reacon-io/reacon-go"
	"net/http"
	"os"
	"reflect"
	"strings"
	"time"
)

type Case struct {
	ID           string                     `json:"id"`
	APIClass     string                     `json:"apiClass"`
	Parameters   map[string]json.RawMessage `json:"parameters"`
	RequestModel string                     `json:"requestModel"`
	Record       struct {
		OperationID string `json:"operationId"`
		Request     struct {
			Authentication string          `json:"authentication"`
			Body           json.RawMessage `json:"body"`
		} `json:"request"`
		Response struct {
			Status    int             `json:"status"`
			Body      json.RawMessage `json:"body"`
			MediaType string          `json:"mediaType"`
		} `json:"response"`
	} `json:"record"`
}
type Result struct {
	ID     string `json:"id"`
	Passed bool   `json:"passed"`
	Error  string `json:"error,omitempty"`
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func check(ok bool, message string) {
	if !ok {
		panic(message)
	}
}
func upper(s string) string { return strings.ToUpper(s[:1]) + s[1:] }
func decode(raw json.RawMessage, typ reflect.Type) reflect.Value {
	value := reflect.New(typ)
	must(json.Unmarshal(raw, value.Interface()))
	return value.Elem()
}
func normalize(v any) any {
	switch x := v.(type) {
	case string:
		if parsed, err := time.Parse(time.RFC3339Nano, x); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	case []any:
		for i := range x {
			x[i] = normalize(x[i])
		}
	case map[string]any:
		for k, v := range x {
			x[k] = normalize(v)
		}
	}
	return v
}
func equalJSON(actual []byte, expected []byte) bool {
	var a, b any
	must(json.Unmarshal(actual, &a))
	must(json.Unmarshal(expected, &b))
	return reflect.DeepEqual(normalize(a), normalize(b))
}
func run(item Case, operations map[string][]string) (result Result) {
	result.ID = item.ID
	defer func() {
		if err := recover(); err != nil {
			result.Error = fmt.Sprint(err)
			result.Passed = false
		}
	}()
	cfg := sdk.NewConfiguration()
	cfg.Servers = sdk.ServerConfigurations{{URL: os.Getenv("REACON_TEST_URL") + "/" + item.ID}}
	client := sdk.NewAPIClient(cfg)
	ctx := context.Background()
	if item.Record.Request.Authentication != "none" {
		ctx = context.WithValue(ctx, sdk.ContextAPIKeys, map[string]sdk.APIKey{"ApiKey": {Key: "recording-go"}})
	}
	api := reflect.ValueOf(client).Elem().FieldByName(strings.TrimSuffix(item.APIClass, "Api") + "API")
	method := api.MethodByName(upper(item.Record.OperationID))
	check(method.IsValid(), "Missing operation")
	arguments, exists := operations[upper(item.Record.OperationID)]
	check(exists, "Missing parsed operation arguments")
	values := []reflect.Value{reflect.ValueOf(ctx)}
	used := map[string]bool{}
	for i, name := range arguments {
		raw, ok := item.Parameters[name]
		check(ok, "Missing argument "+name)
		values = append(values, decode(raw, method.Type().In(i+1)))
		used[name] = true
	}
	request := method.Call(values)[0]
	for name, raw := range item.Parameters {
		if used[name] {
			continue
		}
		setter := request.MethodByName(upper(name))
		check(setter.IsValid(), "Missing parameter "+name)
		request = setter.Call([]reflect.Value{decode(raw, setter.Type().In(0))})[0]
	}
	if len(item.Record.Request.Body) > 0 {
		setter := request.MethodByName(item.RequestModel)
		check(setter.IsValid(), "Missing request body setter")
		request = setter.Call([]reflect.Value{decode(item.Record.Request.Body, setter.Type().In(0))})[0]
	}
	execute := "Execute"
	var csvInput *sdk.ExportLeadsRequest
	if item.Record.Response.MediaType == "text/csv" {
		rejected := request.MethodByName("Execute").Call(nil)
		check(rejected[1].IsNil() && !rejected[2].IsNil() && strings.Contains(rejected[2].Interface().(error).Error(), "ExecuteCSV"), "JSON export must reject CSV before sending")
		csvInput = &sdk.ExportLeadsRequest{}
		must(json.Unmarshal(item.Record.Request.Body, csvInput))
		csvInput.SetFormat("json")
		request = reflect.ValueOf(request.Interface().(sdk.ApiExportLeadsRequest).ExportLeadsRequest(*csvInput))
		execute = "ExecuteCSV"
	}
	executed := request.MethodByName(execute).Call(nil)
	// Native void operations return only (*http.Response, error).
	if len(executed) == 2 {
		executed = append([]reflect.Value{reflect.ValueOf((*interface{})(nil))}, executed...)
	}
	if csvInput != nil {
		check(csvInput.GetFormat() == "json", "CSV export mutated caller input")
	}
	check(len(executed) == 3, "Unexpected execute result")
	if !executed[1].IsNil() {
		defer executed[1].Interface().(*http.Response).Body.Close()
		check(executed[1].Interface().(*http.Response).StatusCode == item.Record.Response.Status, "HTTP status differs")
	}
	if !executed[2].IsNil() {
		err := executed[2].Interface().(error)
		check(!executed[1].IsNil(), fmt.Sprint(err))
		response := executed[1].Interface().(*http.Response)
		check(item.Record.Response.Status >= 400 && response.StatusCode == item.Record.Response.Status, fmt.Sprintf("Unexpected error %d: %v", response.StatusCode, err))
		typed, ok := err.(*sdk.GenericOpenAPIError)
		check(ok, "Missing structured HTTP error")
		check(equalJSON(typed.Body(), item.Record.Response.Body), "Error body differs")
	} else {
		check(item.Record.Response.Status < 400, "Expected HTTP error")
		actual, err := json.Marshal(executed[0].Interface())
		must(err)
		check(equalJSON(actual, item.Record.Response.Body), "Decoded response differs: "+string(actual))
	}
	result.Passed = true
	return
}
func main() {
    for _, addresses := range []interface{}{nil, map[string]interface{}{}, []interface{}{}, "example", false, 1.25, map[string]interface{}{"city":"Example","lines":[]interface{}{nil,"Synthetic street"}}} {
        input := map[string]interface{}{"addresses":addresses,"id":"00000000-0000-4000-8000-000000000001","name":"Synthetic company","domain":"example.invalid","website":"https://example.invalid","location":nil,"industry":nil,"numberOfEmployees":nil,"type":nil,"foundedOn":nil,"linkedin":nil,"twitter":nil}
        encoded, err := json.Marshal(input); must(err)
        var company sdk.ProductCompany; must(json.Unmarshal(encoded,&company))
        _, present := company.GetAddressesOk(); check(present,"Required JSON null was treated as absent")
        actual, err := json.Marshal(company); must(err)
        check(equalJSON(actual,encoded),"Required arbitrary JSON value was lost")
        company.SetAddresses(nil)
        nulled, err := json.Marshal(company); must(err)
        var nulledMap map[string]interface{}; must(json.Unmarshal(nulled,&nulledMap))
        _, exists := nulledMap["addresses"]; check(exists && nulledMap["addresses"] == nil,"Setter lost explicit JSON null")
        delete(input,"addresses"); missing, err := json.Marshal(input); must(err)
        check(json.Unmarshal(missing,&company)!=nil,"Missing required JSON field was accepted")
    }
    var missingCompany *sdk.ProductCompany
    _, missingPresent := missingCompany.GetAddressesOk(); check(!missingPresent,"Nil model reports a present JSON field")
    // Closed anyOf dispatch must preserve all keys, including overlapping shapes.
    for _, input := range []string{`{}`, `{"limit":2,"listId":"00000000-0000-4000-8000-000000000001"}`, `{"domain":"example.invalid"}`, `{"email":"sdk@example.invalid","idempotencyKey":"synthetic-regression-1","firstName":"SDK"}`, `{"sequenceId":"00000000-0000-4000-8000-000000000001","idempotencyKey":"synthetic-regression-2","recipients":[{"email":"sdk@example.invalid"}]}`} {
        var value sdk.ProductToolRequestInput
        must(json.Unmarshal([]byte(input), &value))
        encoded, err := json.Marshal(value); must(err)
        var want, got any; must(json.Unmarshal([]byte(input), &want)); must(json.Unmarshal(encoded, &got))
        check(reflect.DeepEqual(want, got), "Product input union lost fields: " + input + " -> " + string(encoded))
    }
    for _, input := range []string{`null`, `[]`, `{"unknown":true}`, `{"domain":"example.invalid","unknown":true}`, `{"recipientId":"00000000-0000-4000-8000-000000000001"}`} {
        var value sdk.ProductToolRequestInput
        check(json.Unmarshal([]byte(input), &value) != nil, "Invalid product input accepted: " + input)
    }
    for _, tool := range []string{"team_members", "saved_searches_list", "leads_list"} {
        // Actual success bodies are checked by the response corpus below.
        var value sdk.ProductToolExecution
        check(json.Unmarshal([]byte(`{"tool":"`+tool+`"}`), &value) != nil, "Discriminator bypassed required payload fields")
    }
    var unknown sdk.ProductToolExecution
    check(json.Unmarshal([]byte(`{"tool":"unknown"}`), &unknown) != nil, "Unknown discriminator accepted")
	var patch sdk.UpdateLeadRequest
	must(json.Unmarshal([]byte(`{"company_addresses":null,"person_first_name":null}`), &patch))
	encoded, err := json.Marshal(patch)
	must(err)
	check(equalJSON(encoded, []byte(`{"company_addresses":null,"person_first_name":null}`)), "Patch omitted/null distinction lost")
	company := sdk.NewLeadPageResultsInnerCompany()
	check(!company.HasAddresses(), "Absent collection marked present")
	company.SetAddresses(nil)
	_, present := company.GetAddressesOk()
	check(present, "Explicit null collection marked absent")
	encoded, err = json.Marshal(company)
	must(err)
	check(equalJSON(encoded, []byte(`{"addresses":null}`)), "Explicit null collection lost")
	company.UnsetAddresses()
	encoded, err = json.Marshal(company)
	must(err)
	check(equalJSON(encoded, []byte(`{}`)), "Unset collection was emitted")
	company.SetAddresses([]map[string]interface{}{})
	encoded, err = json.Marshal(company)
	must(err)
	check(equalJSON(encoded, []byte(`{"addresses":[]}`)), "Empty array collapsed")
	var tracking sdk.MailGetTrackingDomainResponse200
	must(json.Unmarshal([]byte(`{"domain":null}`), &tracking))
	check(tracking.Domain.IsNull(), "Nullable record state lost")
	check(json.Unmarshal([]byte(`{}`), &tracking) != nil, "Missing required nullable property accepted")
	check(json.Unmarshal([]byte(`{"domain":{}}`), &tracking) != nil, "Malformed record accepted as null")
	var cases []Case
	data, err := os.ReadFile(os.Getenv("REACON_CASES_FILE"))
	must(err)
	must(json.Unmarshal(data, &cases))
	var operations map[string][]string
	data, err = os.ReadFile("operations.json")
	must(err)
	must(json.Unmarshal(data, &operations))
	results := make([]Result, 0, len(cases))
	passed := 0
	for _, item := range cases {
		result := run(item, operations)
		results = append(results, result)
		if result.Passed {
			passed++
		}
	}
	data, err = json.MarshalIndent(results, "", "  ")
	must(err)
	must(os.WriteFile(os.Getenv("REACON_RESULTS_FILE"), data, 0600))
	fmt.Printf("%d/%d recorded responses passed through Go methods\n", passed, len(cases))
	if passed != len(cases) {
		for _, result := range results { if !result.Passed { detail, _ := json.Marshal(result); fmt.Fprintln(os.Stderr, string(detail)) } }
		os.Exit(1)
	}
}
