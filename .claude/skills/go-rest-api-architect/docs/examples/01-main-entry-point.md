# Main Entry Point Examples

## Standard Main.go Pattern

The main.go file is the entry point of your Go REST API. It should:
- Load configuration
- Initialize database connection
- Create and start the HTTP server
- Handle graceful shutdown

---

## Example 1: PostgreSQL API (blog0)

```go
package main

import (
	"blog0/config"
	"blog0/db"
	_ "blog0/docs"
	"blog0/server"
)

// @title           Blog0 API
// @version         1.0
// @description     This is the blog0 API.
// @termsOfService  http://swagger.io/terms/

// @contact.name   API Support
// @contact.url    http://www.swagger.io/support
// @contact.email  support@swagger.io

// @license.name  Apache 2.0
// @license.url   http://www.apache.org/licenses/LICENSE-2.0.html

// @host      localhost:8080
// @BasePath  /api/v1

// @securityDefinitions.basic  BasicAuth

// @externalDocs.description  OpenAPI
// @externalDocs.url          https://swagger.io/resources/open-api/
func main() {
	cfg := config.Load()
	db, err := db.New(cfg.PostgresURI)
	if err != nil {
		panic(err)
	}
	defer db.Close()

	router := server.New(cfg, db)
	router.Run(":" + cfg.APIPort)
}
```

**Key Points:**
- Uses Swagger annotations for API documentation
- Proper error handling for database connection
- Defers database cleanup
- Simple and clean structure

---

## Example 2: MongoDB API (env0)

```go
package main

import (
	"context"
	"env0/config"
	"env0/db"
	"env0/server"

	_ "env0/docs"
)

// @title           Env0 API
// @version         1.0
// @description     This is the env0 API.
// @termsOfService  http://swagger.io/terms/

// @contact.name   API Support
// @contact.url    http://www.swagger.io/support
// @contact.email  support@swagger.io

// @license.name  Apache 2.0
// @license.url   http://www.apache.org/licenses/LICENSE-2.0.html

// @host      localhost:8080
// @BasePath  /api/v1

// @securityDefinitions.basic  BasicAuth

// @externalDocs.description  OpenAPI
// @externalDocs.url          https://swagger.io/resources/open-api/
func main() {
	cfg := config.Load()
	db, client := db.New(cfg)
	defer client.Disconnect(context.Background())
	router := server.New(cfg, db)
	router.Run(":" + cfg.APIPort)
}
```

**Key Points:**
- MongoDB returns both database and client
- Uses context.Background() for disconnect
- Client disconnect is deferred

---

## Directory Structure for cmd/

```
cmd/
└── api/
    └── main.go
```

or for multiple services:

```
cmd/
├── api/
│   └── main.go
├── worker/
│   └── main.go
└── migrator/
    └── main.go
```

---

## Best Practices

1. **Keep main.go simple** - Only initialization logic
2. **Use defer for cleanup** - Ensure resources are released
3. **Panic on critical failures** - Database connection errors, missing required config
4. **Document your API** - Use Swagger annotations
5. **Separate concerns** - Server setup goes in server package, not main
