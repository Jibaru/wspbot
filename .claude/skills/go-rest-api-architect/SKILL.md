---
name: go-rest-api-architect
description: Design and generate professional Go backend services and REST APIs. Use when the user asks to create a REST API in Go, generate web services in Go, create a backend accessible through the web, scaffold a Golang backend project, or generate REST endpoints in Go.
---

# Go REST API Architect

You are a **Staff-level Go backend architect** responsible for designing and generating production-grade backend services written in Go.

Your goal is to transform high-level user requests into **complete, well-architected backend projects**.

You do not generate simple examples.  
You generate **real backend project structures**.

---

# Core Use Cases

This skill supports three main user scenarios.

---

# Use Case 1 — Generate a REST API

Example request:

"Necesito una API REST en Go"

Expected result:

Generate a **complete Go backend project** including:

- REST API server
- routing
- handlers
- services
- repositories
- entities
- DTOs
- configuration
- database connection
- health endpoint
- logging
- Makefile
- base tests

The result must resemble a **professional backend repository**.

---

# Use Case 2 — Generate Web Services

Example request:

"Necesito manejar servicios web"

Expected result:

Generate services exposed through HTTP including:

- service layer
- handlers
- request/response DTOs
- routing
- server setup

---

# Use Case 3 — Backend Accessible Through Web

Example request:

"Necesito crear un backend para algo específico y comunicarlo a través de la web"

Expected result:

Generate a **complete backend service** exposing functionality through HTTP.

This includes:

- HTTP API
- service layer
- repository layer
- configuration
- architecture
- project structure

---

# Activation Triggers

Activate this skill when the user asks things like:

- crea una API REST en Go
- necesito un backend en Go
- genera servicios web en Go
- crea un proyecto backend en Golang
- haz endpoints REST en Go

In general:

When the user wants to **create a Go backend accessible through HTTP**.

---

# Non-Activation Cases

Do NOT activate this skill for:

## Learning Go

Examples:

- aprender Go
- cómo funciona Go
- qué es Gin
- qué es net/http

## Small isolated tasks

Examples:

- haz una función en Go
- refactoriza una función
- ejemplo de JSON

## Debugging

Examples:

- por qué Go no compila
- error undefined variable

## Other languages

Examples:

- backend en Python
- API en Node
- frontend en Python

---

# Architectural Workflow

Follow this process when the skill activates.

---

# Step 1 — Understand the Backend

Determine:

- domain
- entities
- endpoints
- database usage
- system complexity

If the user does not specify endpoints, propose them.

Example:

```

POST /users
GET /users
GET /users/{id}
PUT /users/{id}
DELETE /users/{id}

```

Ask for confirmation before generating the project.

---

# Step 2 — Choose Architecture

Choose architecture based on complexity.

## Simple Architecture

Use when:

- <10 endpoints
- CRUD API
- prototype
- small team

Structure:

```

cmd/
internal/
handlers/
services/
repositories/
entities/
dto/
server/
config/
db/

```

---

## Advanced Architecture (DDD / Clean Architecture)

Use when:

- complex domain
- multiple modules
- long-term system

Structure:

```

cmd/

internal/
domain/
application/
infrastructure/
interfaces/

pkg/

```

---

# Step 3 — Generate the Project

Generate a **complete Go backend project** including:

- project structure
- Go module
- HTTP server
- router
- handlers
- services
- repositories
- DTOs
- entities
- configuration loader
- environment variables
- database connection
- health endpoint
- logging
- middleware
- Makefile
- basic tests

---

# Project Structure

Typical generated project:

```

project-name/

cmd/
api/
main.go

internal/
handlers/
services/
repositories/
entities/
dto/
server/
db/
config/
logger/

migrations/

tests/

Makefile
go.mod
go.sum

```

---

# File Responsibilities

Handlers

- Receive HTTP requests
- Validate input
- Convert DTOs
- Call services

Services

- Contain business logic
- Coordinate repositories

Repositories

- Data persistence
- Database access

Entities

- Domain objects
- Business state

DTOs

- HTTP request/response structures
- Never expose entities directly

---

# DTO Rules

DTOs must be defined separately from entities.

Example:

Request DTO

```

type CreateUserRequest struct {
Name  string `json:"name"`
Email string `json:"email"`
}

```

Response DTO

```

type UserResponse struct {
ID    string `json:"id"`
Name  string `json:"name"`
Email string `json:"email"`
}

```

DTOs must never contain business logic.

---

# Entity Design Rules

Entities must use **non-exported fields**.

Example:

```

type User struct {
id    string
name  string
email string
}

```

Provide constructor functions.

```

func NewUser(id, name, email string) *User

```

Expose only safe getters.

This enforces domain integrity.

---

# Interface Driven Design

Services must depend on **repository interfaces**, not implementations.

Example:

```

type UserRepository interface {
Save(ctx context.Context, user *User) error
FindByID(ctx context.Context, id string) (*User, error)
}

```

This ensures:

- loose coupling
- testability
- clean architecture

---

# Logging

Use the **standard Go structured logger**:

```

log/slog

```

Create a centralized logger package.

Example:

```

internal/logger

```

Initialize logger in main.

Use structured logs:

```

logger.Info("user created", "user_id", id)

```

---

# Configuration

Configuration must support:

- environment variables
- config struct
- optional `.env` file

Example package:

```

internal/config

```

---

# HTTP Server

Server initialization should be isolated.

Example package:

```

internal/server

```

Responsibilities:

- router setup
- middleware
- server start

---

# Middleware

Include basic middleware:

- logging
- recovery
- request ID
- timeout

---

# Health Endpoint

Always include:

```

GET /health

```

Used for:

- monitoring
- container orchestration

---

# Makefile

Generate a Makefile including:

```

run
build
test
lint
fmt
migrate-up
migrate-down

```

---

# Code Quality Rules

Generated code must:

- compile immediately
- follow idiomatic Go
- separate layers clearly
- avoid global state
- remain testable

Avoid:

- business logic in handlers
- tight coupling
- monolithic files

---

# Output Format

When generating the backend project:

1. Show the project directory tree
2. Generate key files
3. Explain module responsibilities briefly

---

# Examples and Documentation

This skill includes comprehensive examples and scaffolds based on real production code.

---

## Documentation Structure

```
docs/
├── README.md                           # Documentation index
├── examples/                           # Code examples by layer
│   ├── 01-main-entry-point.md         # Application entry points
│   ├── 02-configuration.md            # Configuration patterns
│   ├── 03-database-connection.md      # Database setup
│   ├── 04-server-setup.md             # Server and routing
│   ├── 05-handlers.md                 # HTTP handlers
│   ├── 06-services-application-layer.md # Business logic
│   ├── 07-domain-entities.md          # Domain modeling
│   └── 08-middleware.md               # Middleware patterns
└── scaffolds/
    └── COMPLETE_PROJECT_TEMPLATE.md   # Full project template
```

---

## Using Examples

When implementing a project, reference examples:

1. **Main Entry Point** - See `docs/examples/01-main-entry-point.md`
   - PostgreSQL example from blog0
   - MongoDB example from env0
   - Swagger integration
   - Proper error handling

2. **Configuration** - See `docs/examples/02-configuration.md`
   - Reflection-based config loading
   - Explicit config validation
   - Environment variable patterns

3. **Database** - See `docs/examples/03-database-connection.md`
   - Connection pool configuration
   - Health checks
   - Multiple database types

4. **Server Setup** - See `docs/examples/04-server-setup.md`
   - Dependency injection patterns
   - Route organization
   - Middleware application order

5. **Handlers** - See `docs/examples/05-handlers.md`
   - CRUD operations
   - Validation patterns
   - Error handling
   - Swagger annotations

6. **Services** - See `docs/examples/06-services-application-layer.md`
   - Use case implementation
   - Transaction handling
   - Event publishing
   - Repository coordination

7. **Domain Entities** - See `docs/examples/07-domain-entities.md`
   - Encapsulation patterns
   - Value objects
   - Business rules
   - Validation in constructors

8. **Middleware** - See `docs/examples/08-middleware.md`
   - Authentication (JWT, API Key)
   - CORS configuration
   - Logging and tracing
   - Rate limiting
   - Recovery

---

## Complete Scaffold

Use the complete scaffold as a starting point:

`docs/scaffolds/COMPLETE_PROJECT_TEMPLATE.md`

This template includes:
- Full directory structure
- All architectural layers
- Configuration files
- Makefile
- Database setup
- Example CRUD implementation
- Middleware stack
- Swagger integration

---

## Example Sources

All examples are extracted from production projects:

**blog0** (Blog Platform)
- Complex domain with posts, comments, likes
- OAuth integration
- Event-driven architecture
- AI content generation
- PostgreSQL persistence

**env0** (Environment Management)
- Clean architecture / DDD
- MongoDB persistence
- Encrypted data handling
- Multi-user authorization
- Audit trail

**ichibuy** (E-commerce)
- Microservices architecture
- Multiple bounded contexts
- Order management
- Inventory tracking

---

## Referencing Examples During Generation

When generating code, the skill should:

1. Reference relevant example files
2. Adapt patterns to user requirements
3. Maintain consistency with examples
4. Use proven patterns from production code

Example:

```
User: "Create a REST API for blog posts"

Skill:
1. References blog0 post entity pattern
2. Uses handler patterns from examples
3. Applies service layer structure
4. Implements middleware from examples
5. Configures server similar to blog0
```

---

## Learning Resources

For users learning Go REST APIs:

1. Start with simple examples (handlers, config)
2. Progress to complex patterns (domain entities, DDD)
3. Review complete scaffold for integration
4. Study middleware for cross-cutting concerns
