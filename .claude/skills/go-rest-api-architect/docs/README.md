# Go REST API Documentation

This documentation contains real-world examples and scaffolds extracted from production Go REST API projects.

---

## 📚 Examples

Code examples organized by architectural layer:

1. **[Main Entry Point](./examples/01-main-entry-point.md)**
   - Standard main.go patterns
   - PostgreSQL and MongoDB examples
   - Swagger integration
   - Graceful startup and shutdown

2. **[Configuration](./examples/02-configuration.md)**
   - Environment variable loading
   - Reflection-based vs explicit config
   - Configuration validation
   - .env file handling

3. **[Database Connection](./examples/03-database-connection.md)**
   - PostgreSQL, MongoDB, MySQL connections
   - Connection pool configuration
   - Health checks
   - Error handling patterns

4. **[Server Setup](./examples/04-server-setup.md)**
   - Router initialization
   - Dependency injection
   - Route organization
   - Middleware application
   - Versioning strategies

5. **[Handlers](./examples/05-handlers.md)**
   - CRUD handlers
   - Request validation
   - Response mapping
   - Error handling
   - Pagination
   - Swagger documentation

6. **[Services/Application Layer](./examples/06-services-application-layer.md)**
   - Business logic implementation
   - Use cases and scripts
   - Repository coordination
   - Transaction handling
   - Domain event publishing

7. **[Domain Entities](./examples/07-domain-entities.md)**
   - Entity design patterns
   - Encapsulation
   - Value objects
   - Business invariants
   - Validation

8. **[Middleware](./examples/08-middleware.md)**
   - JWT authentication
   - CORS
   - Logging
   - Rate limiting
   - Recovery
   - Request tracing

---

## 🏗️ Scaffolds

Complete project templates ready to use:

- **[Complete Project Template](./scaffolds/COMPLETE_PROJECT_TEMPLATE.md)**
  - Full project structure
  - All layers implemented
  - Makefile and configuration
  - Ready to run

---

## 🎯 Quick Start

### Generate a New API

Start with:

```
Create a REST API for managing blog posts with user authentication
```

The skill will:
1. Analyze your requirements
2. Propose endpoints and architecture
3. Generate a complete, production-ready project
4. Include all necessary files and configurations

### Example Requests

**Simple CRUD API:**
```
Create a REST API in Go for managing tasks with CRUD operations
```

**Complex Domain:**
```
Create a Go backend for an e-commerce system with products, orders, and inventory management
```

**Specific Tech Stack:**
```
Create a REST API using PostgreSQL for a blog platform with posts, comments, and user authentication
```

---

## 📖 Learning Path

If you're new to Go REST APIs, follow this path:

1. Start with **Main Entry Point** - understand how the application boots
2. Review **Configuration** - learn how to manage settings
3. Study **Database Connection** - see connection patterns
4. Explore **Server Setup** - understand routing and middleware
5. Learn **Handlers** - see HTTP layer implementation
6. Study **Services** - understand business logic organization
7. Review **Domain Entities** - learn domain modeling
8. Explore **Middleware** - add cross-cutting concerns

---

## 🏛️ Architecture Patterns

### Layered Architecture (Simple Projects)

```
handlers → services → repositories → database
```

**When to use:**
- Small to medium APIs (<15 endpoints)
- Simple business logic
- Quick prototypes

### Clean Architecture / DDD (Complex Projects)

```
interfaces → application → domain
             ↓
         infrastructure
```

**When to use:**
- Complex business domains
- Long-term maintenance
- Multiple team members
- Microservices

---

## 📦 Project Structure Comparison

### Simple Structure
```
internal/
├── handlers/
├── services/
├── repositories/
└── entities/
```

### Clean Architecture Structure
```
internal/
├── domain/         # Business entities and rules
├── application/    # Use cases
├── infrastructure/ # External concerns
└── interfaces/     # HTTP, CLI, gRPC
```

---

## 🔧 Tech Stack

All examples use battle-tested libraries:

- **HTTP Framework**: Gin
- **Database Drivers**: lib/pq (PostgreSQL), mongo-driver (MongoDB)
- **Configuration**: godotenv
- **Authentication**: golang-jwt/jwt
- **Documentation**: swaggo/swag
- **Validation**: go-playground/validator (via Gin)

---

## 🚀 Best Practices

The examples follow these principles:

1. **Dependency Injection** - No global state
2. **Interface-Driven** - Services depend on interfaces
3. **Layer Separation** - Clear boundaries between layers
4. **Error Handling** - Proper error wrapping and domain errors
5. **Validation** - Input validation at boundaries
6. **Testing** - Testable architecture
7. **Documentation** - Swagger annotations

---

## 📝 Contributing

These examples are based on real production code from:

- **blog0** - Blog platform with AI features
- **env0** - Environment management system
- **ichibuy** - E-commerce microservices

---

## 🤝 Support

For questions or issues with the skill:
- Check the examples in this documentation
- Review the complete scaffold
- Ask the user to generate specific examples
