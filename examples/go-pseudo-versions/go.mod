module example.com/demo

go 1.22

require (
	example.com/tagged v1.2.3
	example.com/pseudo-next v1.2.4-0.20210101120000-abcdefabcdef
	example.com/pseudo-base v0.0.0-20191109021931-daa7c04131f5
	example.com/oldmajor v2.0.0+incompatible
	example.com/replaced-mod v1.0.0
	example.com/indirect-mod v1.2.3 // indirect
)

exclude example.com/excluded-mod v1.2.3

replace example.com/replaced-mod => ./local

replace example.com/fork-only => example.com/fork v1.2.3
