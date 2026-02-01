package apptheorycdk

import (
	"github.com/aws/aws-cdk-go/awscdk/v2/awscloudfront"
)

// Configuration for private media access using CloudFront signed URLs/cookies.
type PrivateMediaConfig struct {
	// An existing CloudFront key group to use for trusted key groups.
	//
	// When provided, the distribution will require signed URLs or signed cookies.
	KeyGroup awscloudfront.IKeyGroup `field:"optional" json:"keyGroup" yaml:"keyGroup"`
	// Comment/description for the key group.
	KeyGroupComment *string `field:"optional" json:"keyGroupComment" yaml:"keyGroupComment"`
	// Name for the key group when created.
	// Default: "MediaCdnKeyGroup".
	//
	KeyGroupName *string `field:"optional" json:"keyGroupName" yaml:"keyGroupName"`
	// Name for the public key when created from PEM.
	// Default: "MediaCdnPublicKey".
	//
	PublicKeyName *string `field:"optional" json:"publicKeyName" yaml:"publicKeyName"`
	// Public key PEM content for creating a new key group.
	//
	// Only used if keyGroup is not provided.
	PublicKeyPem *string `field:"optional" json:"publicKeyPem" yaml:"publicKeyPem"`
}

