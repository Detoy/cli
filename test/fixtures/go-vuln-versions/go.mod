module example.com/svc

go 1.22

require (
	github.com/tagged/mod v1.2.3
	github.com/pseudo/base v0.0.0-20240615120000-abcdefabcdef
	github.com/pseudo/after v1.2.4-0.20240615120000-abcdefabcdef
	github.com/old/major v2.3.4+incompatible
	github.com/pseudo/incompat v2.1.0-0.20240615120000-abcdefabcdef+incompatible
	github.com/pseudo/pre v1.2.3-rc.0.20240615120000-abcdefabcdef
	example.com/partial v1.2
	example.com/four v1.2.3.4
	rsc.io/quote v1.5.2 // indirect
)

exclude github.com/tagged/mod v1.2.3

replace github.com/tagged/mod => github.com/other/mod v1.9.9

replace github.com/pseudo/base => ../local
