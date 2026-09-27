package main

import (
 "encoding/json"
 "fmt"
 "go/ast"
 "go/parser"
 "go/token"
 "os"
 "path/filepath"
 "strings"
)

func main() {
 operations := map[string][]string{}
 files, err := filepath.Glob(filepath.Join(os.Args[1], "api_*.go")); if err != nil { panic(err) }
 for _, path := range files {
  parsed, err := parser.ParseFile(token.NewFileSet(), path, nil, 0); if err != nil { panic(err) }
  for _, declaration := range parsed.Decls {
   fn, ok := declaration.(*ast.FuncDecl)
   if !ok || fn.Recv == nil || fn.Type.Results == nil || len(fn.Type.Results.List) != 1 || len(fn.Type.Params.List) == 0 { continue }
   result, ok := fn.Type.Results.List[0].Type.(*ast.Ident)
   if !ok || !strings.HasPrefix(result.Name, "Api") || !strings.HasSuffix(result.Name, "Request") { continue }
   first := fn.Type.Params.List[0]
   if len(first.Names) != 1 || first.Names[0].Name != "ctx" { continue }
   arguments := []string{}
   for _, field := range fn.Type.Params.List[1:] { for _, name := range field.Names { arguments = append(arguments, name.Name) } }
   if _, exists := operations[fn.Name.Name]; exists { panic(fmt.Errorf("duplicate operation %s", fn.Name.Name)) }
   operations[fn.Name.Name] = arguments
  }
 }
 if len(operations) == 0 { panic("no SDK operations found") }
 if err := json.NewEncoder(os.Stdout).Encode(operations); err != nil { panic(err) }
}
