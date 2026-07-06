" Phi Fuchsia Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_fuchsia"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#f0abfc gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#f0abfc
hi IncSearch        guifg=#14141a guibg=#d946ef
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#f0abfc guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#f0abfc guibg=#1f1f26  gui=bold
hi Directory        guifg=#d946ef

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#f0abfc
hi String           guifg=#fae8ff
hi Character        guifg=#fae8ff
hi Number           guifg=#f0abfc
hi Boolean          guifg=#f0abfc
hi Float            guifg=#f0abfc

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#d946ef

hi Statement        guifg=#f0abfc gui=bold
hi Conditional      guifg=#f0abfc gui=bold
hi Repeat           guifg=#f0abfc gui=bold
hi Label            guifg=#f0abfc
hi Operator         guifg=#d946ef
hi Keyword          guifg=#f0abfc gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#86198f
hi Include          guifg=#86198f
hi Define           guifg=#86198f
hi Macro            guifg=#86198f
hi PreCondit        guifg=#86198f

hi Type             guifg=#86198f gui=bold
hi StorageClass     guifg=#86198f
hi Structure        guifg=#86198f
hi Typedef          guifg=#86198f

hi Special          guifg=#f0abfc
hi SpecialChar      guifg=#fae8ff
hi Tag              guifg=#d946ef
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#d946ef    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#f0abfc  guibg=#1f1f26  gui=bold
