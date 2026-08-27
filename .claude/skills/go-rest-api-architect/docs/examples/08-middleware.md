# Middleware Examples

## Middleware Pattern

Middleware in Gin intercepts HTTP requests to:
- Add cross-cutting concerns (logging, auth, CORS)
- Transform requests/responses
- Short-circuit request processing
- Add context values

---

## Example 1: JWT Authentication Middleware

```go
package middlewares

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt"
)

func HasAuthorization(jwtSecret string) gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenString := c.GetHeader("Authorization")
		if tokenString == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Token required",
			})
			return
		}

		tk, err := jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
			return []byte(jwtSecret), nil
		})
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid token",
			})
			return
		}

		if !tk.Valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid token",
			})
			return
		}

		userID, ok := tk.Claims.(jwt.MapClaims)["user_id"].(string)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "Invalid token",
			})
			return
		}

		c.Set("user_id", userID)

		c.Next()
	}
}
```

**Usage:**
```go
api := router.Group("/api/v1")
api.Use(middlewares.HasAuthorization(cfg.JWTSecret))
{
	api.GET("/protected", handler)
}
```

---

## Example 2: CORS Middleware

```go
package middlewares

import (
	"github.com/gin-gonic/gin"
)

func UseCORS() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE, PATCH")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}
```

**Production-Ready CORS:**
```go
package middlewares

import (
	"github.com/gin-gonic/gin"
)

type CORSConfig struct {
	AllowedOrigins   []string
	AllowedMethods   []string
	AllowedHeaders   []string
	AllowCredentials bool
}

func CORS(config CORSConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.Request.Header.Get("Origin")

		// Check if origin is allowed
		allowed := false
		for _, allowedOrigin := range config.AllowedOrigins {
			if allowedOrigin == "*" || allowedOrigin == origin {
				allowed = true
				break
			}
		}

		if !allowed {
			c.AbortWithStatus(403)
			return
		}

		c.Writer.Header().Set("Access-Control-Allow-Origin", origin)

		if config.AllowCredentials {
			c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		}

		if len(config.AllowedHeaders) > 0 {
			headers := ""
			for i, h := range config.AllowedHeaders {
				if i > 0 {
					headers += ", "
				}
				headers += h
			}
			c.Writer.Header().Set("Access-Control-Allow-Headers", headers)
		}

		if len(config.AllowedMethods) > 0 {
			methods := ""
			for i, m := range config.AllowedMethods {
				if i > 0 {
					methods += ", "
				}
				methods += m
			}
			c.Writer.Header().Set("Access-Control-Allow-Methods", methods)
		}

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	}
}
```

**Usage:**
```go
router.Use(middlewares.CORS(middlewares.CORSConfig{
	AllowedOrigins:   []string{"http://localhost:3000", "https://myapp.com"},
	AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "PATCH"},
	AllowedHeaders:   []string{"Content-Type", "Authorization"},
	AllowCredentials: true,
}))
```

---

## Example 3: Request ID Middleware

```go
package middlewares

import (
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		requestID := c.GetHeader("X-Request-ID")
		if requestID == "" {
			requestID = uuid.NewString()
		}

		c.Set("request_id", requestID)
		c.Writer.Header().Set("X-Request-ID", requestID)

		c.Next()
	}
}
```

---

## Example 4: Logging Middleware

```go
package middlewares

import (
	"log/slog"
	"time"

	"github.com/gin-gonic/gin"
)

func Logger(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		path := c.Request.URL.Path
		method := c.Request.Method
		requestID := c.GetString("request_id")

		c.Next()

		duration := time.Since(start)
		statusCode := c.Writer.Status()

		logger.Info("HTTP request",
			"request_id", requestID,
			"method", method,
			"path", path,
			"status", statusCode,
			"duration_ms", duration.Milliseconds(),
			"client_ip", c.ClientIP(),
		)
	}
}
```

---

## Example 5: Rate Limiting Middleware

```go
package middlewares

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

type RateLimiter struct {
	requests map[string]*clientRate
	mu       sync.RWMutex
	limit    int
	window   time.Duration
}

type clientRate struct {
	count     int
	resetTime time.Time
}

func NewRateLimiter(limit int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		requests: make(map[string]*clientRate),
		limit:    limit,
		window:   window,
	}

	// Cleanup goroutine
	go rl.cleanup()

	return rl
}

func (rl *RateLimiter) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		clientIP := c.ClientIP()

		rl.mu.Lock()
		defer rl.mu.Unlock()

		now := time.Now()
		client, exists := rl.requests[clientIP]

		if !exists || now.After(client.resetTime) {
			rl.requests[clientIP] = &clientRate{
				count:     1,
				resetTime: now.Add(rl.window),
			}
			c.Next()
			return
		}

		if client.count >= rl.limit {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":       "rate limit exceeded",
				"retry_after": client.resetTime.Unix(),
			})
			return
		}

		client.count++
		c.Next()
	}
}

func (rl *RateLimiter) cleanup() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for ip, client := range rl.requests {
			if now.After(client.resetTime.Add(1 * time.Minute)) {
				delete(rl.requests, ip)
			}
		}
		rl.mu.Unlock()
	}
}
```

**Usage:**
```go
limiter := middlewares.NewRateLimiter(100, 1*time.Minute) // 100 requests per minute
router.Use(limiter.Middleware())
```

---

## Example 6: Timeout Middleware

```go
package middlewares

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

func Timeout(timeout time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
		defer cancel()

		c.Request = c.Request.WithContext(ctx)

		finished := make(chan struct{})
		go func() {
			c.Next()
			finished <- struct{}{}
		}()

		select {
		case <-finished:
			return
		case <-ctx.Done():
			c.AbortWithStatusJSON(http.StatusGatewayTimeout, gin.H{
				"error": "request timeout",
			})
		}
	}
}
```

---

## Example 7: Recovery Middleware

```go
package middlewares

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
)

func Recovery(logger *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		defer func() {
			if err := recover(); err != nil {
				logger.Error("panic recovered",
					"error", err,
					"path", c.Request.URL.Path,
					"method", c.Request.Method,
				)

				c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
					"error": "internal server error",
				})
			}
		}()

		c.Next()
	}
}
```

---

## Example 8: Role-Based Access Control

```go
package middlewares

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func RequireRole(allowedRoles ...string) gin.HandlerFunc {
	return func(c *gin.Context) {
		userRole := c.GetString("user_role")
		if userRole == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "authentication required",
			})
			return
		}

		allowed := false
		for _, role := range allowedRoles {
			if role == userRole {
				allowed = true
				break
			}
		}

		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error": "insufficient permissions",
			})
			return
		}

		c.Next()
	}
}
```

**Usage:**
```go
admin := api.Group("/admin")
admin.Use(middlewares.HasAuthorization(jwtSecret))
admin.Use(middlewares.RequireRole("admin", "superadmin"))
{
	admin.GET("/users", handlers.ListAllUsers)
}
```

---

## Example 9: API Key Authentication

```go
package middlewares

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

func APIKeyAuth(validKeys map[string]string) gin.HandlerFunc {
	return func(c *gin.Context) {
		apiKey := c.GetHeader("X-API-Key")
		if apiKey == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "API key required",
			})
			return
		}

		clientID, valid := validKeys[apiKey]
		if !valid {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"error": "invalid API key",
			})
			return
		}

		c.Set("client_id", clientID)
		c.Next()
	}
}
```

---

## Middleware Chain Order

```go
func setupRouter(cfg config.Config) *gin.Engine {
	router := gin.New() // Use gin.New() instead of gin.Default()

	// 1. Recovery (must be first to catch all panics)
	router.Use(middlewares.Recovery(logger))

	// 2. CORS (before any routing)
	router.Use(middlewares.CORS())

	// 3. Request ID (for tracing)
	router.Use(middlewares.RequestID())

	// 4. Logging (after request ID is set)
	router.Use(middlewares.Logger(logger))

	// 5. Rate limiting (protect before expensive operations)
	router.Use(limiter.Middleware())

	// 6. Timeout (apply timeout to all requests)
	router.Use(middlewares.Timeout(30 * time.Second))

	// Route-specific middleware comes later
	api := router.Group("/api/v1")
	api.Use(middlewares.HasAuthorization(cfg.JWTSecret))
	{
		// Protected routes
	}

	return router
}
```

---

## Best Practices

### 1. Always Call c.Next() or c.Abort()

```go
// Good: Calls Next() to continue chain
func MyMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Do something before
		c.Next()
		// Do something after
	}
}

// Good: Aborts chain on error
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isAuthenticated(c) {
			c.AbortWithStatus(401)
			return
		}
		c.Next()
	}
}
```

### 2. Use c.Set() to Pass Data

```go
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := extractUserID(c)
		c.Set("user_id", userID)
		c.Next()
	}
}

// In handler
func MyHandler(c *gin.Context) {
	userID := c.GetString("user_id")
	// use userID
}
```

### 3. Return Middleware Factory for Configuration

```go
// Good: Configurable middleware
func Timeout(duration time.Duration) gin.HandlerFunc {
	return func(c *gin.Context) {
		// use duration
	}
}

// Usage
router.Use(middlewares.Timeout(5 * time.Second))
```

### 4. Handle Errors Gracefully

```go
func MyMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if err := doSomething(); err != nil {
			c.AbortWithStatusJSON(500, gin.H{"error": "middleware error"})
			return
		}
		c.Next()
	}
}
```
