" Phi Cyan Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_cyan"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#67e8f9 gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a  gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a  gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a  guibg=#67e8f9
hi IncSearch        guifg=#14141a  guibg=#06b6d4
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#67e8f9 guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#67e8f9 guibg=#1f1f26  gui=bold
hi Directory        guifg=#06b6d4

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#67e8f9
hi String           guifg=#a5f3fc
hi Character        guifg=#a5f3fc
hi Number           guifg=#67e8f9
hi Boolean          guifg=#67e8f9
hi Float            guifg=#67e8f9

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#06b6d4

hi Statement        guifg=#67e8f9 gui=bold
hi Conditional      guifg=#67e8f9 gui=bold
hi Repeat           guifg=#67e8f9 gui=bold
hi Label            guifg=#67e8f9
hi Operator         guifg=#06b6d4
hi Keyword          guifg=#67e8f9 gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#0e7490
hi Include          guifg=#0e7490
hi Define           guifg=#0e7490
hi Macro            guifg=#0e7490
hi PreCondit        guifg=#0e7490

hi Type             guifg=#0e7490 gui=bold
hi StorageClass     guifg=#0e7490
hi Structure        guifg=#0e7490
hi Typedef          guifg=#0e7490

hi Special          guifg=#67e8f9
hi SpecialChar      guifg=#a5f3fc
hi Tag              guifg=#06b6d4
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#06b6d4    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a  guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#67e8f9  guibg=#1f1f26  gui=bold
