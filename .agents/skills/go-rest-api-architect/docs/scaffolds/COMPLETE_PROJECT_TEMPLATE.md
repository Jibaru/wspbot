# Complete Go REST API Project Scaffold

This is a complete, production-ready REST API project template based on real-world patterns from blog0, env0, and ichibuy projects.

---

## Project Structure

```
myapi/
├── cmd/
│   └── api/
│       └── main.go                 # Application entry point
├── internal/
│   ├── config/
│   │   └── config.go               # Configuration loader
│   ├── domain/
│   │   ├── user.go                 # User entity
│   │   ├── post.go                 # Post entity
│   │   └── errors.go               # Domain errors
│   ├── repository/
│   │   ├── user_repository.go      # User repository interface
│   │   └── postgres/
│   │       └── user_repository.go  # PostgreSQL implementation
│   ├── service/
│   │   └── user_service.go         # Business logic layer
│   ├── handlers/
│   │   ├── user_handler.go         # HTTP handlers
│   │   └── common.go               # Common handler utilities
│   ├── middleware/
│   │   ├── auth.go                 # JWT authentication
│   │   ├── cors.go                 # CORS middleware
│   │   ├── logger.go               # Request logging
│   │   └── recovery.go             # Panic recovery
│   ├── server/
│   │   └── server.go               # Server setup and routing
│   └── db/
│       └── db.go                   # Database connection
├── migrations/
│   ├── 001_create_users_table.up.sql
│   └── 001_create_users_table.down.sql
├── tests/
│   ├── integration/
│   └── unit/
├── .env.example                     # Example environment variables
├── .gitignore
├── go.mod
├── go.sum
├── Makefile                         # Common tasks
└── README.md
```

---

## File: cmd/api/main.go

```go
package main

import (
	"log"

	"myapi/internal/config"
	"myapi/internal/db"
	_ "myapi/docs" // Swagger docs
	"myapi/internal/server"
)

// @title           MyAPI
// @version         1.0
// @description     A production-ready REST API
// @termsOfService  http://swagger.io/terms/

// @contact.name   API Support
// @contact.email  support@example.com

// @license.name  MIT
// @license.url   http://opensource.org/licenses/MIT

// @host      localhost:8080
// @BasePath  /api/v1

// @securityDefinitions.apikey BearerAuth
// @in header
// @name Authorization
func main() {
	cfg := config.Load()

	database, err := db.New(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer database.Close()

	router := server.New(cfg, database)

	log.Printf("Server starting on port %s", cfg.APIPort)
	if err := router.Run(":" + cfg.APIPort); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
```

---

## File: internal/config/config.go

```go
package config

import (
	"errors"
	"log"
	"os"
	"reflect"

	"github.com/joho/godotenv"
)

type Config struct {
	DatabaseURL string `env:"DATABASE_URL"`
	JWTSecret   string `env:"JWT_SECRET"`
	APIPort     string `env:"API_PORT"`
	Environment string `env:"ENVIRONMENT"`
}

func Load() Config {
	if err := godotenv.Load(); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			log.Println(".env not found, using environment variables")
		} else {
			log.Fatal("error loading .env:", err)
		}
	}

	var cfg Config
	loadFromEnv(&cfg)
	validate(&cfg)
	return cfg
}

func loadFromEnv(cfg *Config) {
	v := reflect.ValueOf(cfg).Elem()
	t := v.Type()

	for i := 0; i < v.NumField(); i++ {
		field := v.Field(i)
		fieldType := t.Field(i)

		if envTag := fieldType.Tag.Get("env"); envTag != "" {
			if envValue := os.Getenv(envTag); envValue != "" {
				field.SetString(envValue)
			}
		}
	}

	// Set defaults
	if cfg.APIPort == "" {
		cfg.APIPort = "8080"
	}
	if cfg.Environment == "" {
		cfg.Environment = "development"
	}
}

func validate(cfg *Config) {
	if cfg.DatabaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}
	if cfg.JWTSecret == "" {
		log.Fatal("JWT_SECRET is required")
	}
}
```

---

## File: internal/db/db.go

```go
package db

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

func New(url string) (*sql.DB, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(10 * time.Minute)

	if err = db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return db, nil
}
```

---

## File: internal/domain/user.go

```go
package domain

import (
	"errors"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var (
	ErrInvalidEmail    = errors.New("invalid email")
	ErrInvalidPassword = errors.New("invalid password")
)

type User struct {
	id           string
	email        string
	passwordHash string
	name         string
	createdAt    time.Time
	updatedAt    time.Time
}

func NewUser(id, email, password, name string) (*User, error) {
	if email == "" {
		return nil, ErrInvalidEmail
	}
	if len(password) < 8 {
		return nil, ErrInvalidPassword
	}
	if name == "" {
		return nil, errors.New("name is required")
	}

	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}

	now := time.Now()
	return &User{
		id:           id,
		email:        email,
		passwordHash: string(hashedPassword),
		name:         name,
		createdAt:    now,
		updatedAt:    now,
	}, nil
}

// Getters
func (u *User) ID() string           { return u.id }
func (u *User) Email() string        { return u.email }
func (u *User) Name() string         { return u.name }
func (u *User) CreatedAt() time.Time { return u.createdAt }
func (u *User) UpdatedAt() time.Time { return u.updatedAt }

func (u *User) ValidatePassword(password string) bool {
	err := bcrypt.CompareHashAndPassword([]byte(u.passwordHash), []byte(password))
	return err == nil
}

func (u *User) ChangeName(name string) error {
	if name == "" {
		return errors.New("name cannot be empty")
	}
	u.name = name
	u.updatedAt = time.Now()
	return nil
}
```

---

## File: internal/repository/user_repository.go

```go
package repository

import (
	"context"
	"errors"

	"myapi/internal/domain"
)

var ErrNotFound = errors.New("not found")

type UserRepository interface {
	Save(ctx context.Context, user *domain.User) error
	FindByID(ctx context.Context, id string) (*domain.User, error)
	FindByEmail(ctx context.Context, email string) (*domain.User, error)
	FindAll(ctx context.Context, offset, limit int) ([]*domain.User, error)
	Update(ctx context.Context, user *domain.User) error
	Delete(ctx context.Context, id string) error
	Count(ctx context.Context) (int64, error)
}
```

---

## File: internal/repository/postgres/user_repository.go

```go
package postgres

import (
	"context"
	"database/sql"
	"errors"

	"myapi/internal/domain"
	"myapi/internal/repository"
)

type UserRepository struct {
	db *sql.DB
}

func NewUserRepository(db *sql.DB) *UserRepository {
	return &UserRepository{db: db}
}

func (r *UserRepository) Save(ctx context.Context, user *domain.User) error {
	query := `
		INSERT INTO users (id, email, password_hash, name, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`
	_, err := r.db.ExecContext(ctx, query,
		user.ID(),
		user.Email(),
		user.PasswordHash(),
		user.Name(),
		user.CreatedAt(),
		user.UpdatedAt(),
	)
	return err
}

func (r *UserRepository) FindByID(ctx context.Context, id string) (*domain.User, error) {
	query := `
		SELECT id, email, password_hash, name, created_at, updated_at
		FROM users WHERE id = $1
	`
	var user domain.User
	err := r.db.QueryRowContext(ctx, query, id).Scan(
		&user.id,
		&user.email,
		&user.passwordHash,
		&user.name,
		&user.createdAt,
		&user.updatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) FindByEmail(ctx context.Context, email string) (*domain.User, error) {
	query := `
		SELECT id, email, password_hash, name, created_at, updated_at
		FROM users WHERE email = $1
	`
	var user domain.User
	err := r.db.QueryRowContext(ctx, query, email).Scan(
		&user.id,
		&user.email,
		&user.passwordHash,
		&user.name,
		&user.createdAt,
		&user.updatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, repository.ErrNotFound
		}
		return nil, err
	}
	return &user, nil
}

func (r *UserRepository) FindAll(ctx context.Context, offset, limit int) ([]*domain.User, error) {
	query := `
		SELECT id, email, password_hash, name, created_at, updated_at
		FROM users
		ORDER BY created_at DESC
		LIMIT $1 OFFSET $2
	`
	rows, err := r.db.QueryContext(ctx, query, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var users []*domain.User
	for rows.Next() {
		var user domain.User
		if err := rows.Scan(
			&user.id,
			&user.email,
			&user.passwordHash,
			&user.name,
			&user.createdAt,
			&user.updatedAt,
		); err != nil {
			return nil, err
		}
		users = append(users, &user)
	}
	return users, rows.Err()
}

func (r *UserRepository) Update(ctx context.Context, user *domain.User) error {
	query := `
		UPDATE users
		SET name = $1, email = $2, updated_at = $3
		WHERE id = $4
	`
	_, err := r.db.ExecContext(ctx, query,
		user.Name(),
		user.Email(),
		user.UpdatedAt(),
		user.ID(),
	)
	return err
}

func (r *UserRepository) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM users WHERE id = $1`
	_, err := r.db.ExecContext(ctx, query, id)
	return err
}

func (r *UserRepository) Count(ctx context.Context) (int64, error) {
	query := `SELECT COUNT(*) FROM users`
	var count int64
	err := r.db.QueryRowContext(ctx, query).Scan(&count)
	return count, err
}
```

---

## File: internal/service/user_service.go

```go
package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"myapi/internal/domain"
	"myapi/internal/repository"
)

var (
	ErrUserNotFound = errors.New("user not found")
	ErrUserExists   = errors.New("user already exists")
)

type UserService struct {
	userRepo repository.UserRepository
}

func NewUserService(userRepo repository.UserRepository) *UserService {
	return &UserService{userRepo: userRepo}
}

func (s *UserService) Create(ctx context.Context, email, password, name string) (*domain.User, error) {
	existing, _ := s.userRepo.FindByEmail(ctx, email)
	if existing != nil {
		return nil, ErrUserExists
	}

	id := uuid.NewString()
	user, err := domain.NewUser(id, email, password, name)
	if err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	if err := s.userRepo.Save(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to save user: %w", err)
	}

	return user, nil
}

func (s *UserService) GetByID(ctx context.Context, id string) (*domain.User, error) {
	user, err := s.userRepo.FindByID(ctx, id)
	if err != nil {
		if errors.Is(err, repository.ErrNotFound) {
			return nil, ErrUserNotFound
		}
		return nil, err
	}
	return user, nil
}

func (s *UserService) List(ctx context.Context, page, pageSize int) ([]*domain.User, int64, error) {
	offset := (page - 1) * pageSize
	users, err := s.userRepo.FindAll(ctx, offset, pageSize)
	if err != nil {
		return nil, 0, err
	}

	count, err := s.userRepo.Count(ctx)
	if err != nil {
		return nil, 0, err
	}

	return users, count, nil
}
```

---

## File: internal/handlers/user_handler.go

```go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"myapi/internal/service"
)

type UserHandler struct {
	userService *service.UserService
}

func NewUserHandler(userService *service.UserService) *UserHandler {
	return &UserHandler{userService: userService}
}

type CreateUserReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
	Name     string `json:"name" binding:"required"`
}

type UserResp struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func (h *UserHandler) Create(c *gin.Context) {
	var req CreateUserReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResp{Error: err.Error()})
		return
	}

	user, err := h.userService.Create(c, req.Email, req.Password, req.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResp{Error: err.Error()})
		return
	}

	c.JSON(http.StatusCreated, UserResp{
		ID:    user.ID(),
		Email: user.Email(),
		Name:  user.Name(),
	})
}

func (h *UserHandler) Get(c *gin.Context) {
	id := c.Param("id")

	user, err := h.userService.GetByID(c, id)
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResp{Error: "user not found"})
		return
	}

	c.JSON(http.StatusOK, UserResp{
		ID:    user.ID(),
		Email: user.Email(),
		Name:  user.Name(),
	})
}
```

---

## File: internal/server/server.go

```go
package server

import (
	"database/sql"

	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"

	"myapi/internal/config"
	"myapi/internal/handlers"
	"myapi/internal/middleware"
	"myapi/internal/repository/postgres"
	"myapi/internal/service"
)

func New(cfg config.Config, db *sql.DB) *gin.Engine {
	router := gin.Default()

	// Global middleware
	router.Use(middleware.CORS())
	router.Use(middleware.RequestID())
	router.Use(middleware.Recovery())

	// Health check
	router.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "healthy"})
	})

	// Initialize layers
	userRepo := postgres.NewUserRepository(db)
	userService := service.NewUserService(userRepo)
	userHandler := handlers.NewUserHandler(userService)

	// API routes
	api := router.Group("/api/v1")
	{
		users := api.Group("/users")
		{
			users.POST("", userHandler.Create)
			users.GET("/:id", userHandler.Get)
		}
	}

	// Swagger
	router.GET("/swagger/*any", ginSwagger.WrapHandler(swaggerFiles.Handler))

	return router
}
```

---

## File: Makefile

```makefile
.PHONY: run build test lint fmt migrate-up migrate-down help

run:
	@echo "Starting server..."
	@go run cmd/api/main.go

build:
	@echo "Building..."
	@go build -o bin/api cmd/api/main.go

test:
	@echo "Running tests..."
	@go test -v ./...

lint:
	@echo "Running linter..."
	@golangci-lint run

fmt:
	@echo "Formatting code..."
	@go fmt ./...
	@goimports -w .

migrate-up:
	@echo "Running migrations..."
	@migrate -path migrations -database "${DATABASE_URL}" up

migrate-down:
	@echo "Reverting migrations..."
	@migrate -path migrations -database "${DATABASE_URL}" down

help:
	@echo "Available commands:"
	@echo "  make run         - Run the server"
	@echo "  make build       - Build the binary"
	@echo "  make test        - Run tests"
	@echo "  make lint        - Run linter"
	@echo "  make fmt         - Format code"
	@echo "  make migrate-up  - Run database migrations"
	@echo "  make migrate-down- Revert database migrations"
```

---

## File: .env.example

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/myapi?sslmode=disable

# Security
JWT_SECRET=your-super-secret-jwt-key-change-in-production

# Server
API_PORT=8080
ENVIRONMENT=development
```

---

## File: go.mod

```go
module myapi

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	github.com/google/uuid v1.5.0
	github.com/joho/godotenv v1.5.1
	github.com/lib/pq v1.10.9
	golang.org/x/crypto v0.17.0
	github.com/swaggo/files v1.0.1
	github.com/swaggo/gin-swagger v1.6.0
)
```

---

## Setup Instructions

1. **Initialize project:**
   ```bash
   mkdir myapi && cd myapi
   go mod init myapi
   ```

2. **Install dependencies:**
   ```bash
   go get github.com/gin-gonic/gin
   go get github.com/google/uuid
   go get github.com/joho/godotenv
   go get github.com/lib/pq
   go get golang.org/x/crypto/bcrypt
   ```

3. **Setup database:**
   ```bash
   createdb myapi
   ```

4. **Create .env file:**
   ```bash
   cp .env.example .env
   # Edit .env with your values
   ```

5. **Run migrations:**
   ```bash
   make migrate-up
   ```

6. **Run server:**
   ```bash
   make run
   ```

The server will start on `http://localhost:8080`
