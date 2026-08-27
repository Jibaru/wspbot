# Example of postgres implementation

```go
package persistence

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"<project-module>/internal/domain"
)

var _ domain.AppRepo = &appRepo{}

type appRepo struct {
	db                *pgxpool.Pool
	table             string
	appEnvironmentKey string
}

type AppRow struct {
	ID                   uuid.UUID
	Name                 string
	UserID               uuid.UUID
	EncryptedEnvs        string
	OtherUsersAllowedIDs []uuid.UUID
	CreatedAt            time.Time
}

func appFromDomain(app domain.App, appEnvironmentKey string) AppRow {
	encryptedEnvs, _ := app.EncryptedEnvsAsString(appEnvironmentKey)

	return AppRow{
		ID:                   app.ID(),
		Name:                 app.Name(),
		UserID:               app.UserID(),
		EncryptedEnvs:        encryptedEnvs,
		OtherUsersAllowedIDs: app.OtherUsersAllowedIDs(),
		CreatedAt:            app.CreatedAt(),
	}
}

func appToDomain(app *AppRow, appEnvironmentKey string) (*domain.App, error) {
	decryptedEnvs, err := domain.DecryptAESMap(app.EncryptedEnvs, appEnvironmentKey)
	if err != nil {
		return nil, err
	}

	return domain.NewApp(
		app.ID,
		app.Name,
		app.UserID,
		decryptedEnvs,
		app.OtherUsersAllowedIDs,
		app.CreatedAt,
	)
}

func NewAppRepo(db *pgxpool.Pool, appEnvironmentKey string) *appRepo {
	return &appRepo{db: db, table: "apps", appEnvironmentKey: appEnvironmentKey}
}

func (r *appRepo) SaveApp(ctx context.Context, app domain.App) error {
	row := appFromDomain(app, r.appEnvironmentKey)

	query := fmt.Sprintf(`
		INSERT INTO %s (id, name, user_id, encrypted_envs, other_users_allowed_ids, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, r.table)

	_, err := r.db.Exec(ctx, query,
		row.ID,
		row.Name,
		row.UserID,
		row.EncryptedEnvs,
		row.OtherUsersAllowedIDs,
		row.CreatedAt,
	)

	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique_violation
			return fmt.Errorf("%w: app with ID %s already exists", domain.ErrSaveApp, app.ID())
		}
		return fmt.Errorf("%w: %v", domain.ErrSaveApp, err)
	}

	return nil
}

func (r *appRepo) UpdateApp(ctx context.Context, app domain.App) error {
	row := appFromDomain(app, r.appEnvironmentKey)

	query := fmt.Sprintf(`
		UPDATE %s
		SET name = $2, user_id = $3, encrypted_envs = $4, other_users_allowed_ids = $5, created_at = $6
		WHERE id = $1
	`, r.table)

	result, err := r.db.Exec(ctx, query,
		row.ID,
		row.Name,
		row.UserID,
		row.EncryptedEnvs,
		row.OtherUsersAllowedIDs,
		row.CreatedAt,
	)

	if err != nil {
		return fmt.Errorf("%w: %v", domain.ErrUpdateApp, err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("%w: app with ID %s not found", domain.ErrUpdateApp, app.ID())
	}

	return nil
}

func (r *appRepo) DeleteApp(ctx context.Context, appID domain.ID) error {
	query := fmt.Sprintf(`DELETE FROM %s WHERE id = $1`, r.table)

	result, err := r.db.Exec(ctx, query, appID)
	if err != nil {
		return fmt.Errorf("%w: %v", domain.ErrDeleteApp, err)
	}

	if result.RowsAffected() == 0 {
		return fmt.Errorf("%w: app with ID %s not found", domain.ErrDeleteApp, appID)
	}

	return nil
}

func (r *appRepo) ListApps(ctx context.Context, criteria domain.Criteria) ([]domain.App, error) {
	whereClause, args := criteriaToSQL(criteria)

	query := fmt.Sprintf(`
		SELECT id, name, user_id, encrypted_envs, other_users_allowed_ids, created_at
		FROM %s
		%s
	`, r.table, whereClause)

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrListApps, err)
	}
	defer rows.Close()

	apps := make([]domain.App, 0)
	for rows.Next() {
		var app AppRow
		if err := rows.Scan(
			&app.ID,
			&app.Name,
			&app.UserID,
			&app.EncryptedEnvs,
			&app.OtherUsersAllowedIDs,
			&app.CreatedAt,
		); err != nil {
			return nil, fmt.Errorf("%w: failed to scan app row: %v", domain.ErrListApps, err)
		}

		domainApp, err := appToDomain(&app, r.appEnvironmentKey)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to convert app to domain model: %v", domain.ErrListApps, err)
		}

		apps = append(apps, *domainApp)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrListApps, err)
	}

	return apps, nil
}

// criteriaToSQL converts domain criteria to SQL WHERE clause and arguments
func criteriaToSQL(criteria domain.Criteria) (string, []interface{}) {
	if len(criteria.Filters) == 0 {
		return "", nil
	}

	var conditions []string
	var args []interface{}
	argPosition := 1

	for key, value := range criteria.Filters {
		// Convert camelCase to snake_case for SQL column names
		columnName := toSnakeCase(key)
		conditions = append(conditions, fmt.Sprintf("%s = $%d", columnName, argPosition))
		args = append(args, value)
		argPosition++
	}

	whereClause := "WHERE " + strings.Join(conditions, " AND ")

	// Add ORDER BY if specified
	if criteria.SortBy != "" {
		sortColumn := toSnakeCase(criteria.SortBy)
		sortOrder := "ASC"
		if criteria.SortOrder == "desc" {
			sortOrder = "DESC"
		}
		whereClause += fmt.Sprintf(" ORDER BY %s %s", sortColumn, sortOrder)
	}

	// Add LIMIT and OFFSET if specified
	if criteria.Limit > 0 {
		whereClause += fmt.Sprintf(" LIMIT $%d", argPosition)
		args = append(args, criteria.Limit)
		argPosition++
	}

	if criteria.Offset > 0 {
		whereClause += fmt.Sprintf(" OFFSET $%d", argPosition)
		args = append(args, criteria.Offset)
	}

	return whereClause, args
}

// toSnakeCase converts camelCase or PascalCase to snake_case
func toSnakeCase(s string) string {
	var result strings.Builder
	for i, r := range s {
		if i > 0 && r >= 'A' && r <= 'Z' {
			result.WriteRune('_')
		}
		result.WriteRune(r)
	}
	return strings.ToLower(result.String())
}
```