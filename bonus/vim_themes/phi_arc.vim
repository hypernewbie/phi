" Phi Arc Vim/Neovim Colorscheme
" Generated for Phi

highlight clear
if exists("syntax_on")
  syntax reset
endif
let g:colors_name = "phi_arc"
set background=dark

" Core UI
hi Normal           guifg=#e4e3e9  guibg=#14141a
hi CursorLine                    guibg=#141418
hi CursorColumn                  guibg=#141418
hi LineNr           guifg=#78768a
hi CursorLineNr     guifg=#708cff gui=bold
hi StatusLine       guifg=#e4e3e9  guibg=#1f1f26  gui=none
hi StatusLineNC     guifg=#78768a  guibg=#0d0d10  gui=none
hi VertSplit        guifg=#1f1f26  guibg=#14141a gui=none
hi WinSeparator     guifg=#1f1f26  guibg=#14141a gui=none
hi Visual                        guibg=#1f1f26
hi Search           guifg=#14141a guibg=#708cff
hi IncSearch        guifg=#14141a guibg=#2952ff
hi Pmenu            guifg=#e4e3e9  guibg=#0d0d10
hi PmenuSel         guifg=#708cff guibg=#1f1f26  gui=bold
hi PmenuSbar                     guibg=#141418
hi PmenuThumb                    guibg=#78768a
hi MatchParen       guifg=#708cff guibg=#1f1f26  gui=bold
hi Directory        guifg=#2952ff

" Syntax Highlighting
hi Comment          guifg=#505060 gui=italic
hi Constant         guifg=#708cff
hi String           guifg=#b8c7ff
hi Character        guifg=#b8c7ff
hi Number           guifg=#708cff
hi Boolean          guifg=#708cff
hi Float            guifg=#708cff

hi Identifier       guifg=#e4e3e9
hi Function         guifg=#2952ff

hi Statement        guifg=#708cff gui=bold
hi Conditional      guifg=#708cff gui=bold
hi Repeat           guifg=#708cff gui=bold
hi Label            guifg=#708cff
hi Operator         guifg=#2952ff
hi Keyword          guifg=#708cff gui=bold
hi Exception        guifg=#b06060

hi PreProc          guifg=#1433b8
hi Include          guifg=#1433b8
hi Define           guifg=#1433b8
hi Macro            guifg=#1433b8
hi PreCondit        guifg=#1433b8

hi Type             guifg=#1433b8 gui=bold
hi StorageClass     guifg=#1433b8
hi Structure        guifg=#1433b8
hi Typedef          guifg=#1433b8

hi Special          guifg=#708cff
hi SpecialChar      guifg=#b8c7ff
hi Tag              guifg=#2952ff
hi Delimiter        guifg=#909098
hi SpecialComment   guifg=#78768a

hi Underlined       guifg=#2952ff    gui=underline
hi Ignore           guifg=#78768a
hi Error            guifg=#e4e3e9  guibg=#b06060
hi Todo             guifg=#14141a guibg=#9e8040  gui=bold

" Diff Highlighting
hi DiffAdd          guifg=#34d399 guibg=#0a1f14
hi DiffChange       guifg=#e4e3e9   guibg=#141418
hi DiffDelete       guifg=#f87171 guibg=#1f0a0a
hi DiffText         guifg=#708cff  guibg=#1f1f26  gui=bold
