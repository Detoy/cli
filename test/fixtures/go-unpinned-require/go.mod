module example.com/svc

go 1.22

require (
	github.com/foo/bar v1.2.3
	github.com/gin-gonic/gin
	example.com/ranged >=1.4.0
	rsc.io/quote v1.5.2 // indirect
	example.com/skipped-indirect // indirect
	// example.com/commented-block v9.9.9
)

require example.com/also-unpinned

exclude example.com/excluded v1.2.3

replace example.com/replaced => ../local

// example.com/commented v9.9.9
