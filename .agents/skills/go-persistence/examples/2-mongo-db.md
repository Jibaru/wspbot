# Example of mongo implementation

```go
package persistence

import (
	"context"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"

	"<project-module>/internal/domain"
)

var _ domain.AppRepo = &appRepo{}

type appRepo struct {
	db                *mongo.Database
	collection        string
	appEnvironmentKey string
}

type AppDoc struct {
	ID                   primitive.ObjectID   `bson:"_id"`
	Name                 string               `bson:"name"`
	UserID               primitive.ObjectID   `bson:"userId"`
	EncryptedEnvs        string               `bson:"encryptedEnvs"`
	OtherUsersAllowedIDs []primitive.ObjectID `bson:"otherUsersAllowedIDs"`
	CreatedAt            time.Time            `bson:"createdAt"`
}

func appFromDomain(app domain.App, appEnvironmentKey string) AppDoc {
	encryptedEnvs, _ := app.EncryptedEnvsAsString(appEnvironmentKey)

	return AppDoc{
		ID:                   app.ID(),
		Name:                 app.Name(),
		UserID:               app.UserID(),
		EncryptedEnvs:        encryptedEnvs,
		OtherUsersAllowedIDs: app.OtherUsersAllowedIDs(),
		CreatedAt:            app.CreatedAt(),
	}
}

func appToDomain(app *AppDoc, appEnvironmentKey string) (*domain.App, error) {
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

func NewAppRepo(db *mongo.Database, appEnvironmentKey string) *appRepo {
	return &appRepo{db: db, collection: "apps", appEnvironmentKey: appEnvironmentKey}
}

func (r *appRepo) SaveApp(ctx context.Context, app domain.App) error {
	collection := r.db.Collection(r.collection)
	_, err := collection.InsertOne(ctx, appFromDomain(app, r.appEnvironmentKey))
	if mongo.IsDuplicateKeyError(err) {
		return fmt.Errorf("%w: app with ID %s already exists", domain.ErrSaveApp, app.ID())
	}
	if err != nil {
		return fmt.Errorf("%w: %v", domain.ErrSaveApp, err)
	}
	return nil
}

func (r *appRepo) UpdateApp(ctx context.Context, app domain.App) error {
	collection := r.db.Collection(r.collection)
	result, err := collection.UpdateOne(ctx, bson.M{"_id": app.ID()}, map[string]any{
		"$set": appFromDomain(app, r.appEnvironmentKey),
	})
	if err != nil {
		return fmt.Errorf("%w: %v", domain.ErrUpdateApp, err)
	}
	if result.MatchedCount == 0 {
		return fmt.Errorf("%w: app with ID %s not found", domain.ErrUpdateApp, app.ID())
	}
	return nil
}

func (r *appRepo) DeleteApp(ctx context.Context, appID domain.ID) error {
	collection := r.db.Collection(r.collection)
	result, err := collection.DeleteOne(ctx, map[string]any{"_id": appID})
	if err != nil {
		return fmt.Errorf("%w: %v", domain.ErrDeleteApp, err)
	}
	if result.DeletedCount == 0 {
		return fmt.Errorf("%w: app with ID %s not found", domain.ErrDeleteApp, appID)
	}
	return nil
}

func (r *appRepo) ListApps(ctx context.Context, criteria domain.Criteria) ([]domain.App, error) {
	collection := r.db.Collection(r.collection)
	cursor, err := collection.Aggregate(ctx, criteriaToPipeline(criteria))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", domain.ErrListApps, err)
	}
	defer cursor.Close(ctx)

	apps := make([]domain.App, 0)
	for cursor.Next(ctx) {
		var app AppDoc
		if err := cursor.Decode(&app); err != nil {
			return nil, fmt.Errorf("%w: failed to decode app document: %v", domain.ErrListApps, err)
		}

		domainApp, err := appToDomain(&app, r.appEnvironmentKey)
		if err != nil {
			return nil, fmt.Errorf("%w: failed to convert app to domain model: %v", domain.ErrListApps, err)
		}

		apps = append(apps, *domainApp)
	}

	return apps, nil
}
```