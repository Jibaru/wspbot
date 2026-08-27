# Database Connection Examples

## Database Layer Responsibilities

The database package should:
- Initialize database connection
- Handle connection pooling
- Validate connectivity
- Provide clean error messages

---

## Example 1: PostgreSQL Connection

```go
package db

import (
	"database/sql"

	_ "github.com/lib/pq"
)

func New(url string) (*sql.DB, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, err
	}

	if err = db.Ping(); err != nil {
		return nil, err
	}

	return db, nil
}
```

**Key Points:**
- Import PostgreSQL driver with blank import
- Test connection with Ping()
- Return errors for proper handling

**Enhanced Version with Connection Pool:**

```go
package db

import (
	"database/sql"
	"time"

	_ "github.com/lib/pq"
)

func New(url string) (*sql.DB, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, err
	}

	// Configure connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(10 * time.Minute)

	if err = db.Ping(); err != nil {
		return nil, err
	}

	return db, nil
}
```

---

## Example 2: MongoDB Connection

```go
package db

import (
	"context"
	"env0/config"
	"log"
	"time"

	"go.mongodb.org/mongo-driver/event"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

func New(cfg config.Config) (*mongo.Database, *mongo.Client) {
	// Optional: Command monitoring for debugging
	cmdMonitor := &event.CommandMonitor{
		Started: func(_ context.Context, evt *event.CommandStartedEvent) {
			log.Print(evt.Command)
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	client, err := mongo.Connect(
		ctx,
		options.Client().
			ApplyURI(cfg.MongoURI).
			SetMonitor(cmdMonitor),
	)
	if err != nil {
		log.Fatal(err)
	}

	return client.Database(cfg.DBName), client
}
```

**Key Points:**
- Returns both database and client (client needed for disconnect)
- Uses context with timeout
- Optional command monitoring for development
- Fatal error on connection failure

**Production-Ready MongoDB Connection:**

```go
package db

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

type MongoDB struct {
	Client   *mongo.Client
	Database *mongo.Database
}

func NewMongoDB(uri, dbName string) (*MongoDB, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	clientOptions := options.Client().
		ApplyURI(uri).
		SetMaxPoolSize(10).
		SetMinPoolSize(5).
		SetMaxConnIdleTime(30 * time.Second)

	client, err := mongo.Connect(ctx, clientOptions)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to MongoDB: %w", err)
	}

	// Verify connection
	if err := client.Ping(ctx, readpref.Primary()); err != nil {
		return nil, fmt.Errorf("failed to ping MongoDB: %w", err)
	}

	return &MongoDB{
		Client:   client,
		Database: client.Database(dbName),
	}, nil
}

func (m *MongoDB) Close(ctx context.Context) error {
	return m.Client.Disconnect(ctx)
}
```

---

## Example 3: MySQL Connection

```go
package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

func NewMySQL(host, port, user, password, dbName string) (*sql.DB, error) {
	dsn := fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4",
		user, password, host, port, dbName)

	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("failed to open MySQL connection: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)

	if err = db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping MySQL: %w", err)
	}

	return db, nil
}
```

---

## Connection Pool Best Practices

```go
// Good defaults for most applications
db.SetMaxOpenConns(25)        // Maximum open connections
db.SetMaxIdleConns(5)         // Maximum idle connections
db.SetConnMaxLifetime(5 * time.Minute)  // Maximum lifetime
db.SetConnMaxIdleTime(10 * time.Minute) // Maximum idle time
```

**Rules of thumb:**
- `MaxOpenConns`: Database's max connections / number of app instances
- `MaxIdleConns`: 20-25% of MaxOpenConns
- `ConnMaxLifetime`: 5-15 minutes (helps with load balancers)
- `ConnMaxIdleTime`: Slightly longer than ConnMaxLifetime

---

## Health Check Endpoint

```go
// internal/handlers/health.go
package handlers

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

type HealthHandler struct {
	db *sql.DB
}

func NewHealthHandler(db *sql.DB) *HealthHandler {
	return &HealthHandler{db: db}
}

func (h *HealthHandler) Check(c *gin.Context) {
	if err := h.db.Ping(); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"status": "unhealthy",
			"error":  "database connection failed",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "healthy",
	})
}
```

---

## Database Connection URL Formats

### PostgreSQL
```
postgresql://user:password@host:port/database?sslmode=disable
postgres://user:password@host:port/database?sslmode=require
```

### MongoDB
```
mongodb://user:password@host:port/database
mongodb+srv://user:password@cluster.mongodb.net/database
```

### MySQL
```
user:password@tcp(host:port)/database?parseTime=true&charset=utf8mb4
```

---

## Error Handling Patterns

```go
// Return errors, don't panic in library code
func New(url string) (*sql.DB, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err = db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return db, nil
}

// Panic only in main.go for critical startup failures
func main() {
	cfg := config.Load()
	db, err := db.New(cfg.DatabaseURL)
	if err != nil {
		panic(err) // OK to panic here - can't run without database
	}
	defer db.Close()

	// ... rest of initialization
}
```
