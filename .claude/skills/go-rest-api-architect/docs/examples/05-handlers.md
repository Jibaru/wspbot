# Handler Examples

## Handler Responsibilities

Handlers should ONLY:
- Parse HTTP request (path params, query params, body)
- Validate input format
- Extract authentication context
- Call service/application layer
- Map service response to HTTP response
- Handle HTTP status codes

Handlers should NEVER:
- Contain business logic
- Access database directly
- Perform data transformations (beyond DTO mapping)

---

## Example 1: Create Resource Handler (blog0)

```go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"blog0/internal/services"
)

type CreatePostReq struct {
	Title       string `json:"title" binding:"required"`
	Slug        string `json:"slug" binding:"required"`
	RawMarkdown string `json:"raw_markdown" binding:"required"`
	Publish     bool   `json:"publish"`
}

// CreatePost godoc
// @Summary      Create a new post
// @Description  Create a new post (requires authentication)
// @Accept       json
// @Produce      json
// @Security     BearerAuth
// @Param        body body     CreatePostReq true "Post data"
// @Success      201  {object} services.CreatePostResp
// @Failure      400  {object} ErrorResp
// @Failure      401  {object} ErrorResp
// @Failure      500  {object} ErrorResp
// @Router       /api/v1/me/posts [post]
func CreatePost(createPost *services.CreatePost) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Extract authenticated user ID from context
		userID, exists := c.Get("user_id")
		if !exists {
			c.JSON(http.StatusUnauthorized, ErrorResp{Error: "user not authenticated"})
			return
		}

		// Parse and validate request body
		var body CreatePostReq
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, ErrorResp{Error: err.Error()})
			return
		}

		// Build service request
		req := &services.CreatePostReq{
			Title:       body.Title,
			Slug:        body.Slug,
			RawMarkdown: body.RawMarkdown,
			UserID:      userID.(string),
			Publish:     body.Publish,
		}

		// Execute business logic
		resp, err := createPost.Exec(c, req)
		if err != nil {
			c.JSON(http.StatusInternalServerError, ErrorResp{Error: err.Error()})
			return
		}

		// Return success response
		c.JSON(http.StatusCreated, resp)
	}
}
```

**Key Points:**
- Factory function returns `gin.HandlerFunc`
- Service injected as dependency
- Swagger documentation
- Clear separation: parse → validate → execute → respond
- Proper HTTP status codes (201 for creation)

---

## Example 2: Create Resource with Validation (env0)

```go
package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"env0/internal/application"
)

type CreateAppBody struct {
	Name string `json:"name"`
}

type CreateAppResp struct {
	ID        string                    `json:"id"`
	Name      string                    `json:"name"`
	UserID    string                    `json:"userId"`
	Envs      map[string]map[string]any `json:"envs"`
	CreatedAt time.Time                 `json:"createdAt"`
	OwnerName string                    `json:"ownerName"`
}

// @Summary Create new application
// @Description Creates a new application for the authenticated user
// @Tags apps
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param request body CreateAppBody true "Application details"
// @Success 201 {object} CreateAppResp "Successfully created application"
// @Failure 400 {object} ErrorResp "Invalid request format"
// @Failure 401 {object} ErrorResp "Unauthorized"
// @Failure 500 {object} ErrorResp "Internal server error"
// @Router /api/v1/apps [post]
func CreateApp(createAppScript *application.CreateAppScript) gin.HandlerFunc {
	return func(c *gin.Context) {
		var body CreateAppBody
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, newErrorResp(err))
			return
		}

		resp, err := createAppScript.Exec(c, application.CreateAppReq{
			Name:   body.Name,
			UserID: c.GetString("user_id"),
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, newErrorResp(err))
			return
		}

		c.JSON(http.StatusCreated, CreateAppResp{
			ID:        resp.ID,
			Name:      resp.Name,
			UserID:    resp.UserID,
			Envs:      resp.Envs,
			CreatedAt: resp.CreatedAt,
			OwnerName: resp.OwnerName,
		})
	}
}
```

---

## Example 3: Get Resource Handler

```go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"myapi/internal/service"
)

// GetUser godoc
// @Summary Get user by ID
// @Description Get detailed information about a specific user
// @Tags users
// @Produce json
// @Param id path string true "User ID"
// @Success 200 {object} UserResponse
// @Failure 400 {object} ErrorResp
// @Failure 404 {object} ErrorResp
// @Router /api/v1/users/{id} [get]
func GetUser(userService *service.UserService) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.Param("id")

		user, err := userService.GetByID(c, userID)
		if err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				c.JSON(http.StatusNotFound, ErrorResp{
					Error: "user not found",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, ErrorResp{
				Error: "failed to get user",
			})
			return
		}

		c.JSON(http.StatusOK, toUserResponse(user))
	}
}

type UserResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

func toUserResponse(user *domain.User) UserResponse {
	return UserResponse{
		ID:        user.ID,
		Email:     user.Email,
		Name:      user.Name,
		CreatedAt: user.CreatedAt,
	}
}
```

---

## Example 4: List Resources with Pagination

```go
package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"myapi/internal/service"
)

type ListUsersResponse struct {
	Users      []UserResponse `json:"users"`
	TotalCount int64          `json:"totalCount"`
	Page       int            `json:"page"`
	PageSize   int            `json:"pageSize"`
}

// ListUsers godoc
// @Summary List users
// @Description Get a paginated list of users
// @Tags users
// @Produce json
// @Param page query int false "Page number" default(1)
// @Param pageSize query int false "Items per page" default(20)
// @Success 200 {object} ListUsersResponse
// @Failure 400 {object} ErrorResp
// @Router /api/v1/users [get]
func ListUsers(userService *service.UserService) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Parse pagination parameters
		page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
		pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))

		// Validate pagination
		if page < 1 {
			page = 1
		}
		if pageSize < 1 || pageSize > 100 {
			pageSize = 20
		}

		users, totalCount, err := userService.List(c, page, pageSize)
		if err != nil {
			c.JSON(http.StatusInternalServerError, ErrorResp{
				Error: "failed to list users",
			})
			return
		}

		userResponses := make([]UserResponse, len(users))
		for i, user := range users {
			userResponses[i] = toUserResponse(user)
		}

		c.JSON(http.StatusOK, ListUsersResponse{
			Users:      userResponses,
			TotalCount: totalCount,
			Page:       page,
			PageSize:   pageSize,
		})
	}
}
```

---

## Example 5: Update Resource Handler

```go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"myapi/internal/service"
)

type UpdateUserReq struct {
	Name  *string `json:"name"`
	Email *string `json:"email"`
}

// UpdateUser godoc
// @Summary Update user
// @Description Update user information
// @Tags users
// @Accept json
// @Produce json
// @Security BearerAuth
// @Param id path string true "User ID"
// @Param body body UpdateUserReq true "User data to update"
// @Success 200 {object} UserResponse
// @Failure 400 {object} ErrorResp
// @Failure 403 {object} ErrorResp
// @Failure 404 {object} ErrorResp
// @Router /api/v1/users/{id} [put]
func UpdateUser(userService *service.UserService) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.Param("id")
		authenticatedUserID := c.GetString("user_id")

		// Authorization check
		if userID != authenticatedUserID {
			c.JSON(http.StatusForbidden, ErrorResp{
				Error: "cannot update other user's profile",
			})
			return
		}

		var req UpdateUserReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, ErrorResp{
				Error: err.Error(),
			})
			return
		}

		user, err := userService.Update(c, userID, service.UpdateUserParams{
			Name:  req.Name,
			Email: req.Email,
		})
		if err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				c.JSON(http.StatusNotFound, ErrorResp{
					Error: "user not found",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, ErrorResp{
				Error: "failed to update user",
			})
			return
		}

		c.JSON(http.StatusOK, toUserResponse(user))
	}
}
```

---

## Example 6: Delete Resource Handler

```go
package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"myapi/internal/service"
)

// DeleteUser godoc
// @Summary Delete user
// @Description Delete a user account
// @Tags users
// @Security BearerAuth
// @Param id path string true "User ID"
// @Success 204 "No Content"
// @Failure 403 {object} ErrorResp
// @Failure 404 {object} ErrorResp
// @Router /api/v1/users/{id} [delete]
func DeleteUser(userService *service.UserService) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.Param("id")
		authenticatedUserID := c.GetString("user_id")

		if userID != authenticatedUserID {
			c.JSON(http.StatusForbidden, ErrorResp{
				Error: "cannot delete other user's account",
			})
			return
		}

		err := userService.Delete(c, userID)
		if err != nil {
			if errors.Is(err, service.ErrUserNotFound) {
				c.JSON(http.StatusNotFound, ErrorResp{
					Error: "user not found",
				})
				return
			}
			c.JSON(http.StatusInternalServerError, ErrorResp{
				Error: "failed to delete user",
			})
			return
		}

		c.Status(http.StatusNoContent)
	}
}
```

---

## Common Error Response Pattern

```go
package handlers

type ErrorResp struct {
	Error string `json:"error"`
}

func newErrorResp(err error) ErrorResp {
	return ErrorResp{Error: err.Error()}
}

// More detailed error response
type DetailedErrorResp struct {
	Error   string            `json:"error"`
	Code    string            `json:"code,omitempty"`
	Details map[string]string `json:"details,omitempty"`
}
```

---

## Handler Best Practices

### 1. Use Factory Functions
```go
// Good: Returns handler function, allows dependency injection
func CreateUser(service *service.UserService) gin.HandlerFunc {
	return func(c *gin.Context) {
		// handler logic
	}
}

// Bad: Direct handler, harder to test and inject dependencies
func CreateUser(c *gin.Context) {
	service := getGlobalService() // Avoid global state
	// handler logic
}
```

### 2. Separate Request/Response DTOs
```go
// Request DTO - what comes from client
type CreateUserReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8"`
	Name     string `json:"name" binding:"required"`
}

// Response DTO - what goes to client
type UserResponse struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
	// Never expose password or sensitive data
}
```

### 3. Use Proper HTTP Status Codes
```go
// 2xx Success
c.JSON(http.StatusOK, data)              // 200 - Success
c.JSON(http.StatusCreated, data)         // 201 - Created
c.Status(http.StatusNoContent)           // 204 - No Content

// 4xx Client Errors
c.JSON(http.StatusBadRequest, err)       // 400 - Bad Request
c.JSON(http.StatusUnauthorized, err)     // 401 - Not Authenticated
c.JSON(http.StatusForbidden, err)        // 403 - Not Authorized
c.JSON(http.StatusNotFound, err)         // 404 - Not Found
c.JSON(http.StatusConflict, err)         // 409 - Conflict (e.g., duplicate)

// 5xx Server Errors
c.JSON(http.StatusInternalServerError, err) // 500 - Server Error
```

### 4. Validate Input
```go
type CreateUserReq struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=8,max=72"`
	Name     string `json:"name" binding:"required,min=2,max=100"`
	Age      int    `json:"age" binding:"omitempty,gte=0,lte=150"`
}

// Custom validation
if len(req.Password) < 8 {
	c.JSON(http.StatusBadRequest, ErrorResp{
		Error: "password must be at least 8 characters",
	})
	return
}
```

### 5. Handle Different Error Types
```go
resp, err := service.CreateUser(c, req)
if err != nil {
	switch {
	case errors.Is(err, service.ErrUserExists):
		c.JSON(http.StatusConflict, ErrorResp{Error: "user already exists"})
	case errors.Is(err, service.ErrInvalidInput):
		c.JSON(http.StatusBadRequest, ErrorResp{Error: err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, ErrorResp{Error: "internal error"})
	}
	return
}
```
